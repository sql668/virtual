import { approxEqual, debounce, memo, notUndefined } from './utils'

export * from './utils'

/**
 * ```
 *
 *   1. 测量元素：根据传递的预估大小计算每一个滚动项的位置信息，生成一个VirtualItem对象(记录每一个元素的key,index,起始)，生成measurements数组，该数组记录每一个item的VirtualItem数据
 *   2. 确定可视区域的渲染起始和结束索引。
 *          起始索引: 使用二分法，找出哪一个VirtualItem的start == 当前滚动偏移量
 *          结束索引: 从起始索引位置向后找，最后一个满足该（measurements[endIndex]!.end < 当前滚动偏移量 + 父元素的尺寸）条件的
 *   3. 根据可视区域的起始和结束索引，再结合缓冲区数量配置，从measurements数组中取出对应的数据生成virtualItems
 *   4. 当父元素尺寸变化或者发生滚动事件时，重新计算更新当前渲染范围
 *   5. 触发重渲染
 *
 *
 *  如果是动态模式(子元素尺寸会变化)
 *  1. 获取每一个滚动项的dom实例，更新elementsCache this.elementsCache.set(key, node)
 *  2. 重新测量元素尺寸
 *      如果尺寸发生变化，更新缓存中的值
 *  3. 监听node的尺寸变化，重新测量元素尺寸
 *  4. 触发重渲染
 *
 *
 * ```
 */

/**
 * 滚动方向
 */
type ScrollDirection = 'forward' | 'backward'

type ScrollAlignment = 'start' | 'center' | 'end' | 'auto'

type ScrollBehavior = 'auto' | 'smooth'

export interface ScrollToOptions {
  align?: ScrollAlignment
  behavior?: ScrollBehavior
}

type ScrollToOffsetOptions = ScrollToOptions

type ScrollToIndexOptions = ScrollToOptions

/**
 * 真实渲染范围(可视区域 + 上下缓冲区)
 */
export interface Range {
  /**
   * 可视区域起始索引
   */
  startIndex: number
  /**
   * 可视区域结束索引
   */
  endIndex: number
  /**
   * 上缓冲区/下缓冲区 缓冲元素个数
   */
  overscan: number
  /**
   * 总个数
   */
  count: number
}

type Key = number | string | bigint

/**
 * 虚拟元素
 */
export interface VirtualItem {
  key: Key
  index: number
  /**
   * 起始位置
   */
  start: number
  /**
   * 结束位置
   */
  end: number
  /**
   * 尺寸(宽度/高度)
   */
  size: number
  /**
   * 元素在哪一个泳道
   */
  lane: number
}

export interface Rect {
  width: number
  height: number
}

/**
 * 获取元素最终的尺寸 宽度和高度
 * @param element
 * @returns
 */
const getRect = (element: HTMLElement): Rect => {
  const { offsetWidth, offsetHeight } = element
  return { width: offsetWidth, height: offsetHeight }
}

export const defaultKeyExtractor = (index: number) => index

/**
 * 获取真实渲染元素索引范围（可视区域 + 上缓冲区 + 下缓冲区元素）的默认方案
 * @param range
 * @returns
 */
export const defaultRangeExtractor = (range: Range) => {
  const start = Math.max(range.startIndex - range.overscan, 0)
  const end = Math.min(range.endIndex + range.overscan, range.count - 1)
  const arr = []
  for (let i = start; i <= end; i++) {
    arr.push(i)
  }
  return arr
}

/**
 * ResizeObserver监听instance.scrollElement
 * 当instance.scrollElement(滚动条所在的元素)的尺寸发生变化时执行 cb回调，返回最新的宽高尺寸
 * @param instance
 * @param cb
 * @returns
 */
export const observeElementRect = <T extends Element>(
  instance: Virtualizer<T, any>,
  cb: (rect: Rect) => void,
) => {
  const element = instance.scrollElement
  if (!element) {
    return
  }
  const targetWindow = instance.targetWindow
  if (!targetWindow) {
    return
  }

  const handler = (rect: Rect) => {
    const { width, height } = rect
    cb({ width: Math.round(width), height: Math.round(height) })
  }

  handler(getRect(element as unknown as HTMLElement))

  if (!targetWindow.ResizeObserver) {
    return () => {}
  }

  const observer = new targetWindow.ResizeObserver((entries) => {
    const run = () => {
      const entry = entries[0]
      if (entry?.borderBoxSize) {
        const box = entry.borderBoxSize[0]
        if (box) {
          handler({ width: box.inlineSize, height: box.blockSize })
          return
        }
      }
      handler(getRect(element as unknown as HTMLElement))
    }

    instance.options.useAnimationFrameWithResizeObserver
      ? requestAnimationFrame(run)
      : run()
  })

  observer.observe(element, { box: 'border-box' })

  return () => {
    observer.unobserve(element)
  }
}

const addEventListenerOptions = {
  // 告诉浏览器，内部代码不会调用 preventDefault 阻止默认行为，让浏览器放心开启优化。让滚动更加丝滑
  passive: true,
}

/**
 * instance.scrollElement 是 window时，浏览器窗口resize事件，返回浏览器窗口的尺寸
 * @param instance
 * @param cb
 * @returns
 */
export const observeWindowRect = (
  instance: Virtualizer<Window, any>,
  cb: (rect: Rect) => void,
) => {
  const element = instance.scrollElement
  if (!element) {
    return
  }

  const handler = () => {
    cb({ width: element.innerWidth, height: element.innerHeight })
  }
  handler()

  element.addEventListener('resize', handler, addEventListenerOptions)

  return () => {
    element.removeEventListener('resize', handler)
  }
}

// 当前环境是否支持Scrollend事件
const supportsScrollend =
  typeof window == 'undefined' ? true : 'onscrollend' in window

type ObserveOffsetCallBack = (offset: number, isScrolling: boolean) => void

/**
 * 当instance.scrollElement开始滚动或滚动结束时，回调cb返回scrollLeft 或 scrollTop
 * @param instance
 * @param cb
 * @returns
 */
export const observeElementOffset = <T extends Element>(
  instance: Virtualizer<T, any>,
  cb: ObserveOffsetCallBack,
) => {
  const element = instance.scrollElement
  if (!element) {
    return
  }
  const targetWindow = instance.targetWindow
  if (!targetWindow) {
    return
  }

  let offset = 0
  const fallback =
    instance.options.useScrollendEvent && supportsScrollend
      ? () => undefined
      : debounce(
          targetWindow,
          () => {
            cb(offset, false)
          },
          instance.options.isScrollingResetDelay,
        )

  const createHandler = (isScrolling: boolean) => () => {
    const { horizontal, isRtl } = instance.options
    offset = horizontal
      ? element['scrollLeft'] * ((isRtl && -1) || 1)
      : element['scrollTop']
    fallback()
    cb(offset, isScrolling)
  }
  const handler = createHandler(true)
  const endHandler = createHandler(false)
  endHandler()

  element.addEventListener('scroll', handler, addEventListenerOptions)
  const registerScrollendEvent =
    instance.options.useScrollendEvent && supportsScrollend
  if (registerScrollendEvent) {
    element.addEventListener('scrollend', endHandler, addEventListenerOptions)
  }
  return () => {
    element.removeEventListener('scroll', handler)
    if (registerScrollendEvent) {
      element.removeEventListener('scrollend', endHandler)
    }
  }
}

/**
 * 当instance.scrollElement开始滚动或滚动结束时，回调cb返回scrollLeft 或 scrollTop
 * 这里的instance.scrollElement为window
 * @param instance
 * @param cb
 * @returns
 */
export const observeWindowOffset = (
  instance: Virtualizer<Window, any>,
  cb: ObserveOffsetCallBack,
) => {
  const element = instance.scrollElement
  if (!element) {
    return
  }
  const targetWindow = instance.targetWindow
  if (!targetWindow) {
    return
  }

  let offset = 0
  const fallback =
    instance.options.useScrollendEvent && supportsScrollend
      ? () => undefined
      : debounce(
          targetWindow,
          () => {
            cb(offset, false)
          },
          instance.options.isScrollingResetDelay,
        )

  const createHandler = (isScrolling: boolean) => () => {
    offset = element[instance.options.horizontal ? 'scrollX' : 'scrollY']
    fallback()
    cb(offset, isScrolling)
  }
  const handler = createHandler(true)
  const endHandler = createHandler(false)
  endHandler()

  element.addEventListener('scroll', handler, addEventListenerOptions)
  const registerScrollendEvent =
    instance.options.useScrollendEvent && supportsScrollend
  if (registerScrollendEvent) {
    element.addEventListener('scrollend', endHandler, addEventListenerOptions)
  }
  return () => {
    element.removeEventListener('scroll', handler)
    if (registerScrollendEvent) {
      element.removeEventListener('scrollend', endHandler)
    }
  }
}

/**
 * 使用ResizeObserver监听每一个滚动子元素，当元素尺寸变化时，执行的回调函数，用于测量子元素的最新尺寸(宽度/高度)
 * @param element
 * @param entry
 * @param instance
 * @returns
 */
export const measureElement = <TItemElement extends Element>(
  element: TItemElement,
  entry: ResizeObserverEntry | undefined,
  instance: Virtualizer<any, TItemElement>,
) => {
  debugger
  if (entry?.borderBoxSize) {
    const box = entry.borderBoxSize[0]
    if (box) {
      const size = Math.round(
        box[instance.options.horizontal ? 'inlineSize' : 'blockSize'],
      )
      return size
    }
  }

  return (element as unknown as HTMLElement)[
    instance.options.horizontal ? 'offsetWidth' : 'offsetHeight'
  ]
}

/**
 * 控制window滚动条滚动到指定位置
 * @param offset
 * @param param1
 * @param instance
 */
export const windowScroll = <T extends Window>(
  offset: number,
  {
    adjustments = 0,
    behavior,
  }: { adjustments?: number; behavior?: ScrollBehavior },
  instance: Virtualizer<T, any>,
) => {
  const toOffset = offset + adjustments

  instance.scrollElement?.scrollTo?.({
    [instance.options.horizontal ? 'left' : 'top']: toOffset,
    behavior,
  })
}

/**
 * 控制滚动条滚到指定位置
 * @param offset
 * @param param1
 * @param instance
 */
export const elementScroll = <T extends Element>(
  offset: number,
  {
    adjustments = 0,
    behavior,
  }: { adjustments?: number; behavior?: ScrollBehavior },
  instance: Virtualizer<T, any>,
) => {
  const toOffset = offset + adjustments

  instance.scrollElement?.scrollTo?.({
    [instance.options.horizontal ? 'left' : 'top']: toOffset,
    behavior,
  })
}

export interface VirtualizerOptions<
  TScrollElement extends Element | Window,
  TItemElement extends Element,
> {
  // 要虚拟化的项总数。
  count: number
  /**
   * 返回虚拟器的可滚动元素的函数。如果元素尚不可用，它可能会返回 null。
   */
  getScrollElement: () => TScrollElement | null
  /**
   * 此函数传递每个项目的索引，并应返回每个项目的实际大小（如果要使用 virtualItem.measureElement 动态测量项目，则返回估计大小）。此度量值应返回宽度或高度，具体取决于虚拟器的方向。
   */
  estimateSize: (index: number) => number

  // Required from the framework adapter (but can be overridden)
  scrollToFn: (
    offset: number,
    options: { adjustments?: number; behavior?: ScrollBehavior },
    instance: Virtualizer<TScrollElement, TItemElement>,
  ) => void
  observeElementRect: (
    instance: Virtualizer<TScrollElement, TItemElement>,
    cb: (rect: Rect) => void,
  ) => void | (() => void)
  /**
   * 当instance.scrollElement开始滚动或滚动结束时，回调cb返回scrollLeft 或 scrollTop
   */
  observeElementOffset: (
    instance: Virtualizer<TScrollElement, TItemElement>,
    cb: ObserveOffsetCallBack,
  ) => void | (() => void)
  // Optional
  debug?: boolean
  /**
   * crollElement 的初始 Rect。如果您需要在 SSR 环境中运行虚拟器，这非常有用，否则 defaultalRect 将由 observeElementRect 实现在挂载时计算。
   */
  initialRect?: Rect
  /**
   *当虚拟器的内部状态发生变化时触发的回调函数。它传递了虚拟器实例和 sync 参数。
   * @param instance 虚拟器实例
   * @param sync 滚动当前是否正在进行中。当滚动正在进行时，它是 true，当滚动停止或正在执行其他作（例如调整大小）时，它是 false。
   * @returns
   */
  onChange?: (
    instance: Virtualizer<TScrollElement, TItemElement>,
    sync: boolean,
  ) => void
  measureElement?: (
    element: TItemElement,
    entry: ResizeObserverEntry | undefined,
    instance: Virtualizer<TScrollElement, TItemElement>,
  ) => number
  /**
   * 缓冲区，提起渲染的数目
   * 要在可见区域上方和下方渲染的项目数。
   * 增加此数字将增加呈现虚拟器所需的时间，但可能会降低滚动时在虚拟器顶部和底部看到缓慢呈现空白项的可能性。默认值为 1。
   */
  overscan?: number
  /**
   * 虚拟滚动方向
如果您的虚拟器是水平方向的，请将其设置为 true。
   */
  horizontal?: boolean
  /**
   * 要应用于虚拟器开头的填充（以像素为单位）。
   */
  paddingStart?: number
  /**
   * 要应用于虚拟器末尾的填充（以像素为单位）。
   */
  paddingEnd?: number
  /**
   * 滚动到元素时要应用于虚拟器开头的填充（以像素为单位）。
   */
  scrollPaddingStart?: number
  /**
   * 滚动到元素时要应用于虚拟器末尾的填充（以像素为单位）。
   */
  scrollPaddingEnd?: number
  /**
   * 渲染时列表滚动到的位置。如果您在 SSR 环境中渲染虚拟器或有条件地渲染虚拟器，这将非常有用。
   */
  initialOffset?: number | (() => number)
  /**
   * 此函数传递每个项的索引，并应返回该项的唯一键。此函数的默认功能是返回项的索引，但应尽可能覆盖此索引，以便为整个集中的每个项返回唯一标识符。应记住此函数以防止不必要的重新渲染。
   * @param index
   * @returns
   */
  getItemKey?: (index: number) => Key
  /**
   * 当前渲染范围
   * 此函数接收可见范围索引，并应返回要呈现的索引数组。如果您需要手动在虚拟器中添加或删除项目而不考虑可见范围，这很有用，例如。渲染粘性项目、页眉、页脚等。默认范围提取器实现将返回可见范围索引，并导出为 defaultRangeExtractor。
   */
  rangeExtractor?: (range: Range) => Array<number>
  /**
   * ```
   * 使用此选项，您可以指定滚动偏移的起点。通常，此值表示滚动元素的开头和列表开头之间的空间。
   * 这在常见情况下特别有用，例如，当窗口虚拟器前面有一个标头，或者在单个滚动元素中使用多个虚拟器时。
   * 如果您使用元素的绝对定位，则应考虑 CSS 转换中的 scrollMargin：
   * ```css
   * transform: `translateY(${virtualRow.start - rowVirtualizer.options.scrollMargin}px)`
   * ```
   *
   * 要动态测量 scrollMargin 的值，您可以使用 getBoundingClientRect（） 或 ResizeObserver。这在虚拟列表上方的项目可能更改其高度的情况下非常有用。
   *
   */
  scrollMargin?: number
  /**
   * 此选项允许您设置虚拟化列表中项目之间的间距。它对于保持项目之间一致的视觉分离特别有用，而无需手动调整每个项目的边距或填充。该值以像素为单位指定。
   */
  gap?: number

  /**
   *  索引属性名称，当元素的宽高不固定时，必须提供该属性配置，当元素尺寸变化时，根据该属性判断当前的元素索引
   */
  indexAttribute?: string
  initialMeasurementsCache?: Array<VirtualItem>
  /**
   * ```
   * 泳道： 渲染的时候可以多行/多列渲染。
   * 例如： 在垂直方向上虚拟滚动的情况下，lanes：2 表示每行渲染两个元素，每一个宽度为 50%
   *       在水平方向上虚拟滚动的情况下，lanes：2 表示每列渲染两个元素，每一个高度为 50%
   * ```
   */
  lanes?: number
  isScrollingResetDelay?: number
  useScrollendEvent?: boolean
  /**
   * 设置为 false 以禁用 scrollElement 观察器并重置虚拟器的状态
   */
  enabled?: boolean
  /**
   * 是否反转水平滚动以支持从右到左的语言区域设置。
   */
  isRtl?: boolean
  useAnimationFrameWithResizeObserver?: boolean
}

export class Virtualizer<
  TScrollElement extends Element | Window,
  TItemElement extends Element,
> {
  private unsubs: Array<void | (() => void)> = []
  options!: Required<VirtualizerOptions<TScrollElement, TItemElement>>
  scrollElement: TScrollElement | null = null
  targetWindow: (Window & typeof globalThis) | null = null
  isScrolling = false
  /**
   *
   * 记录每一个元素的位置信息(key、索引、起始位置、结束位置、宽度/高度)
   * @type {Array<VirtualItem>}
   * @memberof Virtualizer
   */
  measurementsCache: Array<VirtualItem> = []
  /**
   * 记录每个滚动item的尺寸大小
   *
   * @private
   * @memberof Virtualizer
   */
  private itemSizeCache = new Map<Key, number>()
  /**
   * 大小发生变化，需要重新测量的元素的index集合
   *
   * @private
   * @type {Array<number>}
   * @memberof Virtualizer
   */
  private pendingMeasuredCacheIndexes: Array<number> = []
  /**
   * 发生滚动的元素的尺寸
   *
   * @type {(Rect | null)}
   * @memberof Virtualizer
   */
  scrollRect: Rect | null = null
  /**
   * 发生滚动后，记录scrollLeft 或 scrollTop
   *
   * @type {(number | null)}
   * @memberof Virtualizer
   */
  scrollOffset: number | null = null
  scrollDirection: ScrollDirection | null = null
  private scrollAdjustments = 0
  shouldAdjustScrollPositionOnItemSizeChange:
    | undefined
    | ((
        item: VirtualItem,
        delta: number,
        instance: Virtualizer<TScrollElement, TItemElement>,
      ) => boolean)

  /**
   * 这里存储的是当前已经渲染的页面中的node节点
   *
   * @memberof Virtualizer
   */
  elementsCache = new Map<Key, TItemElement>()
  private observer = (() => {
    let _ro: ResizeObserver | null = null

    const get = () => {
      if (_ro) {
        return _ro
      }

      if (!this.targetWindow || !this.targetWindow.ResizeObserver) {
        return null
      }

      return (_ro = new this.targetWindow.ResizeObserver((entries) => {
        // 监视每一个滚动元素，当元素尺寸大小发生变化时，重新获取元素的最新尺寸
        entries.forEach((entry) => {
          const run = () => {
            this._measureElement(entry.target as TItemElement, entry)
          }
          this.options.useAnimationFrameWithResizeObserver
            ? requestAnimationFrame(run)
            : run()
        })
      }))
    }

    return {
      disconnect: () => {
        get()?.disconnect()
        _ro = null
      },
      observe: (target: Element) =>
        get()?.observe(target, { box: 'border-box' }),
      unobserve: (target: Element) => get()?.unobserve(target),
    }
  })()

  /**
   * 可视区域的渲染范围
   *
   * @type {({ startIndex: number; endIndex: number } | null)}
   * @memberof Virtualizer
   */
  range: { startIndex: number; endIndex: number } | null = null

  constructor(opts: VirtualizerOptions<TScrollElement, TItemElement>) {
    this.setOptions(opts)
  }

  setOptions = (opts: VirtualizerOptions<TScrollElement, TItemElement>) => {
    Object.entries(opts).forEach(([key, value]) => {
      if (typeof value === 'undefined') delete (opts as any)[key]
    })

    this.options = {
      debug: false,
      initialOffset: 0,
      overscan: 1,
      paddingStart: 0,
      paddingEnd: 0,
      scrollPaddingStart: 0,
      scrollPaddingEnd: 0,
      horizontal: false,
      getItemKey: defaultKeyExtractor,
      rangeExtractor: defaultRangeExtractor,
      onChange: () => {},
      measureElement,
      initialRect: { width: 0, height: 0 },
      scrollMargin: 0,
      gap: 0,
      indexAttribute: 'data-index',
      initialMeasurementsCache: [],
      lanes: 1,
      isScrollingResetDelay: 150,
      enabled: true,
      isRtl: false,
      useScrollendEvent: false,
      useAnimationFrameWithResizeObserver: false,
      ...opts,
    }
  }

  /**
   *
   * @param sync
   */
  private notify = (sync: boolean) => {
    this.options.onChange?.(this, sync)
  }

  /**
   * 当发生如下事件，执行的处理函数， 由适配器触发重渲染
   *  1. 父元素尺寸变化
   *  2. 滚动事件
   *
   * @private
   * @memberof Virtualizer
   */
  private maybeNotify = memo(
    () => {
      // 重新计算可视区域的 起始和结束索引
      this.calculateRange()
      return [
        this.isScrolling,
        this.range ? this.range.startIndex : null,
        this.range ? this.range.endIndex : null,
      ]
    },
    (isScrolling) => {
      this.notify(isScrolling)
    },
    {
      key: process.env.NODE_ENV !== 'production' && 'maybeNotify',
      debug: () => this.options.debug,
      initialDeps: [
        this.isScrolling,
        this.range ? this.range.startIndex : null,
        this.range ? this.range.endIndex : null,
      ] as [boolean, number | null, number | null],
    },
  )

  // 事件清理，取消观察，取消订阅，清理内存
  private cleanup = () => {
    this.unsubs.filter(Boolean).forEach((d) => d!())
    this.unsubs = []
    this.observer.disconnect()
    this.scrollElement = null
    this.targetWindow = null
  }

  _didMount = () => {
    return () => {
      this.cleanup()
    }
  }

  _willUpdate = () => {
    debugger
    // 获取滚动区域的父元素，在该区域内虚拟滚动
    const scrollElement = this.options.enabled
      ? this.options.getScrollElement()
      : null

    if (this.scrollElement !== scrollElement) {
      this.cleanup()

      if (!scrollElement) {
        // 当 this.isScrolling或this.range发生变化时，通知外界 this.options.onChange()
        this.maybeNotify()
        return
      }

      this.scrollElement = scrollElement

      if (this.scrollElement && 'ownerDocument' in this.scrollElement) {
        this.targetWindow = this.scrollElement.ownerDocument.defaultView
      } else {
        this.targetWindow = this.scrollElement?.window ?? null
      }

      this.elementsCache.forEach((cached) => {
        this.observer.observe(cached)
      })
      // 调整滚动条位置
      this._scrollToOffset(this.getScrollOffset(), {
        adjustments: undefined,
        behavior: undefined,
      })

      this.unsubs.push(
        // 监听父元素，当父元素尺寸变化时，执行maybeNotify
        this.options.observeElementRect(this, (rect) => {
          this.scrollRect = rect
          this.maybeNotify()
        }),
      )

      this.unsubs.push(
        // 监听滚动事件
        this.options.observeElementOffset(this, (offset, isScrolling) => {
          this.scrollAdjustments = 0

          // 上一次的滚动偏移量和本次的比较，计算出滚动方向
          this.scrollDirection = isScrolling
            ? this.getScrollOffset() < offset
              ? 'forward'
              : 'backward'
            : null
          // 更新滚动偏移量 scrollLeft 或 scrollTop
          this.scrollOffset = offset
          this.isScrolling = isScrolling

          this.maybeNotify()
        }),
      )
    }
  }

  /**
   * 滚动条所在的节点的尺寸，可以理解为 待渲染的可视区域的尺寸
   * @returns
   */
  private getSize = () => {
    if (!this.options.enabled) {
      this.scrollRect = null
      return 0
    }

    this.scrollRect = this.scrollRect ?? this.options.initialRect

    return this.scrollRect[this.options.horizontal ? 'width' : 'height']
  }

  /**
   * 获取滚动偏移量，scrollLeft 或 scrollTop
   * @returns
   */
  private getScrollOffset = () => {
    if (!this.options.enabled) {
      this.scrollOffset = null
      return 0
    }

    this.scrollOffset =
      this.scrollOffset ??
      (typeof this.options.initialOffset === 'function'
        ? this.options.initialOffset()
        : this.options.initialOffset)

    return this.scrollOffset
  }

  private getFurthestMeasurement = (
    measurements: Array<VirtualItem>,
    index: number,
  ) => {
    const furthestMeasurementsFound = new Map<number, true>()
    const furthestMeasurements = new Map<number, VirtualItem>()
    for (let m = index - 1; m >= 0; m--) {
      const measurement = measurements[m]!

      if (furthestMeasurementsFound.has(measurement.lane)) {
        continue
      }

      const previousFurthestMeasurement = furthestMeasurements.get(
        measurement.lane,
      )
      if (
        previousFurthestMeasurement == null ||
        measurement.end > previousFurthestMeasurement.end
      ) {
        furthestMeasurements.set(measurement.lane, measurement)
      } else if (measurement.end < previousFurthestMeasurement.end) {
        furthestMeasurementsFound.set(measurement.lane, true)
      }

      if (furthestMeasurementsFound.size === this.options.lanes) {
        break
      }
    }

    return furthestMeasurements.size === this.options.lanes
      ? Array.from(furthestMeasurements.values()).sort((a, b) => {
          if (a.end === b.end) {
            return a.index - b.index
          }

          return a.end - b.end
        })[0]
      : undefined
  }

  private getMeasurementOptions = memo(
    () => [
      this.options.count,
      this.options.paddingStart,
      this.options.scrollMargin,
      this.options.getItemKey,
      this.options.enabled,
    ],
    (count, paddingStart, scrollMargin, getItemKey, enabled) => {
      this.pendingMeasuredCacheIndexes = []
      return {
        count,
        paddingStart,
        scrollMargin,
        getItemKey,
        enabled,
      }
    },
    {
      key: false,
    },
  )

  /**
   * 计算所有元素的位置信息（index: i,
          start,
          size,
          end,
          key,
          lane,）
   *
   * @private
   * @memberof Virtualizer
   */
  private getMeasurements = memo(
    () => [this.getMeasurementOptions(), this.itemSizeCache],
    (
      { count, paddingStart, scrollMargin, getItemKey, enabled },
      itemSizeCache,
    ) => {
      if (!enabled) {
        this.measurementsCache = []
        this.itemSizeCache.clear()
        return []
      }

      if (this.measurementsCache.length === 0) {
        this.measurementsCache = this.options.initialMeasurementsCache
        this.measurementsCache.forEach((item) => {
          this.itemSizeCache.set(item.key, item.size)
        })
      }

      const min =
        this.pendingMeasuredCacheIndexes.length > 0
          ? Math.min(...this.pendingMeasuredCacheIndexes)
          : 0
      this.pendingMeasuredCacheIndexes = []

      const measurements = this.measurementsCache.slice(0, min)

      for (let i = min; i < count; i++) {
        const key = getItemKey(i)

        /**
         * 最后一个已经完成位置信息测量的节点的测量信息，整个数据非常重要。
         * 下一个待测量的元素位置信息需要基于它的数据才能计算出起始位置和结束位置。
         * 如果没有其它额外配置的话，下一个元素的起始位置就是furthestMeasurement的结束位置
         */
        const furthestMeasurement =
          this.options.lanes === 1
            ? measurements[i - 1]
            : this.getFurthestMeasurement(measurements, i)

        // 计算起始位置
        const start = furthestMeasurement
          ? furthestMeasurement.end + this.options.gap
          : paddingStart + scrollMargin

        // 元素的宽度/高度
        const measuredSize = itemSizeCache.get(key)
        const size =
          typeof measuredSize === 'number'
            ? measuredSize
            : this.options.estimateSize(i)

        const end = start + size

        const lane = furthestMeasurement
          ? furthestMeasurement.lane
          : i % this.options.lanes

        measurements[i] = {
          index: i,
          start,
          size,
          end,
          key,
          lane,
        }
      }

      this.measurementsCache = measurements

      return measurements
    },
    {
      key: process.env.NODE_ENV !== 'production' && 'getMeasurements',
      debug: () => this.options.debug,
    },
  )

  /**
   * 计算可视区域渲染的范围{ startIndex, endIndex }
   *
   * @memberof Virtualizer
   */
  calculateRange = memo(
    () => [
      this.getMeasurements(),
      this.getSize(),
      this.getScrollOffset(),
      this.options.lanes,
    ],
    (measurements, outerSize, scrollOffset, lanes) => {
      return (this.range =
        measurements.length > 0 && outerSize > 0
          ? calculateRange({
              measurements,
              outerSize,
              scrollOffset,
              lanes,
            })
          : null)
    },
    {
      key: process.env.NODE_ENV !== 'production' && 'calculateRange',
      debug: () => this.options.debug,
    },
  )

  /**
   * ```
   * 获取真实渲染区域(可视区域+缓冲区)需要渲染的索引集合
   * 例如：如果总共有10000个子元素，缓冲区为5，
   * 可视区域起始索引{start:0,end:10},则getVirtualIndexes = [1,2,3,...,10,11,12,13,14,15]
   * 可视区域起始索引{start:10,end:20},则getVirtualIndexes = [5,6,7,8,9,10,11,12,...,20,21,22,23,24,25]
   *
   * ```
   *
   * @memberof Virtualizer
   */
  getVirtualIndexes = memo(
    () => {
      let startIndex: number | null = null
      let endIndex: number | null = null
      // 可视区域的起始索引
      const range = this.calculateRange()
      if (range) {
        startIndex = range.startIndex
        endIndex = range.endIndex
      }
      this.maybeNotify.updateDeps([this.isScrolling, startIndex, endIndex])
      return [
        this.options.rangeExtractor,
        this.options.overscan,
        this.options.count,
        startIndex,
        endIndex,
      ]
    },
    (rangeExtractor, overscan, count, startIndex, endIndex) => {
      return startIndex === null || endIndex === null
        ? []
        : rangeExtractor({
            startIndex,
            endIndex,
            overscan,
            count,
          })
    },
    {
      key: process.env.NODE_ENV !== 'production' && 'getVirtualIndexes',
      debug: () => this.options.debug,
    },
  )

  /**
   * 获取元素节点的索引
   * @param node
   * @returns
   */
  indexFromElement = (node: TItemElement) => {
    const attributeName = this.options.indexAttribute
    const indexStr = node.getAttribute(attributeName)

    if (!indexStr) {
      console.warn(
        `Missing attribute name '${attributeName}={index}' on measured element.`,
      )
      return -1
    }

    return parseInt(indexStr, 10)
  }

  /**
   * 测量元素，获取元素节点的尺寸
   * @param node
   * @param entry
   * @returns
   */
  private _measureElement = (
    node: TItemElement,
    entry: ResizeObserverEntry | undefined,
  ) => {
    // 当前节点对应的索引
    const index = this.indexFromElement(node)
    // 根据索引拿到之前的缓存的测量数据（起始位置、结束位置、宽度/高度 等等）
    const item = this.measurementsCache[index]
    if (!item) {
      return
    }
    const key = item.key
    // 根据key拿到上一次的node(HTMLElement节点)信息
    const prevNode = this.elementsCache.get(key)
    // key对应的前后html节点不相等
    if (prevNode !== node) {
      if (prevNode) {
        this.observer.unobserve(prevNode)
      }
      this.observer.observe(node)
      // 更新elementsCache
      this.elementsCache.set(key, node)
    }

    // isConnected： 如果节点与DOM树连接则返回true,否则返回false。一个元素如果没有插入到dom树中，就是false
    if (node.isConnected) {
      this.resizeItem(index, this.options.measureElement(node, entry, this))
    }
  }

  resizeItem = (index: number, size: number) => {
    const item = this.measurementsCache[index]
    if (!item) {
      return
    }
    const itemSize = this.itemSizeCache.get(item.key) ?? item.size
    const delta = size - itemSize
    // 变化前后尺寸不相等，变大或者变小了
    if (delta !== 0) {
      if (
        this.shouldAdjustScrollPositionOnItemSizeChange !== undefined
          ? this.shouldAdjustScrollPositionOnItemSizeChange(item, delta, this)
          : item.start < this.getScrollOffset() + this.scrollAdjustments
      ) {
        if (process.env.NODE_ENV !== 'production' && this.options.debug) {
          console.info('correction', delta)
        }
        // 更新滚动条位置
        this._scrollToOffset(this.getScrollOffset(), {
          adjustments: (this.scrollAdjustments += delta),
          behavior: undefined,
        })
      }

      this.pendingMeasuredCacheIndexes.push(item.index)
      // 更新缓存
      this.itemSizeCache = new Map(this.itemSizeCache.set(item.key, size))

      this.notify(false)
    }
  }

  /**
   * ```
   * 当item不定宽高时,这里以react为例，每一个item都需要绑定`ref={virtualizer.measureElement}`
   * 作用就是将每一个item的dom元素传入进来，virtualizer监听这些dom的尺寸变化
   ```tsx
   <div
        ref={parentRef}
        className="List"
        style={{
          height: 400,
          width: 400,
          overflowY: 'auto',
          contain: 'strict',
        }}
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${items[0]?.start ?? 0}px)`,
            }}
          >
            {items.map((virtualRow) => (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                className={
                  virtualRow.index % 2 ? 'ListItemOdd' : 'ListItemEven'
                }
              >
                <div style={{ padding: '10px 0' }}>
                  <div>Row {virtualRow.index}</div>
                  <div>{sentences[virtualRow.index]}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      ```
   * ```
   * @param node 
   * @returns 
   */
  measureElement = (node: TItemElement | null | undefined) => {
    debugger
    //这里以react为例， 组件卸载或原有的ref发生变化，也会执行该回调函数，此时node为null
    if (!node) {
      this.elementsCache.forEach((cached, key) => {
        if (!cached.isConnected) {
          // 将那些已经不在dom树中的游离节点取消监听并删除
          this.observer.unobserve(cached)
          this.elementsCache.delete(key)
        }
      })
      return
    }

    this._measureElement(node, undefined)
  }

  /**
   * 获取当前真实渲染区域（可视区域 + 缓冲区）的虚拟滚动项元素
   *
   * @memberof Virtualizer
   */
  getVirtualItems = memo(
    () => [this.getVirtualIndexes(), this.getMeasurements()],
    (indexes, measurements) => {
      debugger
      const virtualItems: Array<VirtualItem> = []

      for (let k = 0, len = indexes.length; k < len; k++) {
        const i = indexes[k]!
        const measurement = measurements[i]!

        virtualItems.push(measurement)
      }

      return virtualItems
    },
    {
      key: process.env.NODE_ENV !== 'production' && 'getVirtualItems',
      debug: () => this.options.debug,
    },
  )

  /**
   * ```
   * 传入滚动偏移量，返回对应的VirtualItem
   * 找到 VirtualItem.start 近似 offset 的VirtualItem
   * ```
   * @param offset
   * @returns
   */
  getVirtualItemForOffset = (offset: number) => {
    const measurements = this.getMeasurements()
    if (measurements.length === 0) {
      return undefined
    }
    return notUndefined(
      measurements[
        findNearestBinarySearch(
          0,
          measurements.length - 1,
          (index: number) => notUndefined(measurements[index]).start,
          offset,
        )
      ],
    )
  }

  getOffsetForAlignment = (
    toOffset: number,
    align: ScrollAlignment,
    itemSize = 0,
  ) => {
    const size = this.getSize()
    const scrollOffset = this.getScrollOffset()

    if (align === 'auto') {
      align = toOffset >= scrollOffset + size ? 'end' : 'start'
    }

    if (align === 'center') {
      // When aligning to a particular item (e.g. with scrollToIndex),
      // adjust offset by the size of the item to center on the item
      toOffset += (itemSize - size) / 2
    } else if (align === 'end') {
      toOffset -= size
    }

    const maxOffset = this.getTotalSize() + this.options.scrollMargin - size

    return Math.max(Math.min(maxOffset, toOffset), 0)
  }

  getOffsetForIndex = (index: number, align: ScrollAlignment = 'auto') => {
    index = Math.max(0, Math.min(index, this.options.count - 1))

    const item = this.measurementsCache[index]
    if (!item) {
      return undefined
    }

    const size = this.getSize()
    const scrollOffset = this.getScrollOffset()

    if (align === 'auto') {
      if (item.end >= scrollOffset + size - this.options.scrollPaddingEnd) {
        align = 'end'
      } else if (item.start <= scrollOffset + this.options.scrollPaddingStart) {
        align = 'start'
      } else {
        return [scrollOffset, align] as const
      }
    }

    const toOffset =
      align === 'end'
        ? item.end + this.options.scrollPaddingEnd
        : item.start - this.options.scrollPaddingStart

    return [
      this.getOffsetForAlignment(toOffset, align, item.size),
      align,
    ] as const
  }

  private isDynamicMode = () => this.elementsCache.size > 0

  scrollToOffset = (
    toOffset: number,
    { align = 'start', behavior }: ScrollToOffsetOptions = {},
  ) => {
    if (behavior === 'smooth' && this.isDynamicMode()) {
      console.warn(
        'The `smooth` scroll behavior is not fully supported with dynamic size.',
      )
    }

    this._scrollToOffset(this.getOffsetForAlignment(toOffset, align), {
      adjustments: undefined,
      behavior,
    })
  }

  scrollToIndex = (
    index: number,
    { align: initialAlign = 'auto', behavior }: ScrollToIndexOptions = {},
  ) => {
    if (behavior === 'smooth' && this.isDynamicMode()) {
      console.warn(
        'The `smooth` scroll behavior is not fully supported with dynamic size.',
      )
    }

    index = Math.max(0, Math.min(index, this.options.count - 1))

    let attempts = 0
    const maxAttempts = 10

    const tryScroll = (currentAlign: ScrollAlignment) => {
      if (!this.targetWindow) return

      const offsetInfo = this.getOffsetForIndex(index, currentAlign)
      if (!offsetInfo) {
        console.warn('Failed to get offset for index:', index)
        return
      }
      const [offset, align] = offsetInfo
      this._scrollToOffset(offset, { adjustments: undefined, behavior })

      this.targetWindow.requestAnimationFrame(() => {
        const currentOffset = this.getScrollOffset()
        const afterInfo = this.getOffsetForIndex(index, align)
        if (!afterInfo) {
          console.warn('Failed to get offset for index:', index)
          return
        }

        if (!approxEqual(afterInfo[0], currentOffset)) {
          scheduleRetry(align)
        }
      })
    }

    const scheduleRetry = (align: ScrollAlignment) => {
      if (!this.targetWindow) return

      attempts++
      if (attempts < maxAttempts) {
        if (process.env.NODE_ENV !== 'production' && this.options.debug) {
          console.info('Schedule retry', attempts, maxAttempts)
        }
        this.targetWindow.requestAnimationFrame(() => tryScroll(align))
      } else {
        console.warn(
          `Failed to scroll to index ${index} after ${maxAttempts} attempts.`,
        )
      }
    }

    tryScroll(initialAlign)
  }

  scrollBy = (delta: number, { behavior }: ScrollToOffsetOptions = {}) => {
    if (behavior === 'smooth' && this.isDynamicMode()) {
      console.warn(
        'The `smooth` scroll behavior is not fully supported with dynamic size.',
      )
    }

    this._scrollToOffset(this.getScrollOffset() + delta, {
      adjustments: undefined,
      behavior,
    })
  }

  /**
   * 获取总宽度/高度
   * @returns
   */
  getTotalSize = () => {
    const measurements = this.getMeasurements()

    let end: number
    // If there are no measurements, set the end to paddingStart
    // If there is only one lane, use the last measurement's end
    // Otherwise find the maximum end value among all measurements
    if (measurements.length === 0) {
      end = this.options.paddingStart
    } else if (this.options.lanes === 1) {
      end = measurements[measurements.length - 1]?.end ?? 0
    } else {
      const endByLane = Array<number | null>(this.options.lanes).fill(null)
      let endIndex = measurements.length - 1
      while (endIndex >= 0 && endByLane.some((val) => val === null)) {
        const item = measurements[endIndex]!
        if (endByLane[item.lane] === null) {
          endByLane[item.lane] = item.end
        }

        endIndex--
      }

      end = Math.max(...endByLane.filter((val): val is number => val !== null))
    }

    return Math.max(
      end - this.options.scrollMargin + this.options.paddingEnd,
      0,
    )
  }

  /**
   * 滚动位置
   * @param offset
   * @param param1
   */
  private _scrollToOffset = (
    offset: number,
    {
      adjustments,
      behavior,
    }: {
      adjustments: number | undefined
      behavior: ScrollBehavior | undefined
    },
  ) => {
    this.options.scrollToFn(offset, { behavior, adjustments }, this)
  }

  measure = () => {
    this.itemSizeCache = new Map()
    this.notify(false)
  }
}

const findNearestBinarySearch = (
  low: number,
  high: number,
  getCurrentValue: (i: number) => number,
  value: number,
) => {
  while (low <= high) {
    const middle = ((low + high) / 2) | 0
    const currentValue = getCurrentValue(middle)

    if (currentValue < value) {
      low = middle + 1
    } else if (currentValue > value) {
      high = middle - 1
    } else {
      return middle
    }
  }

  if (low > 0) {
    return low - 1
  } else {
    return 0
  }
}

/**
 * 可视区域的{ startIndex, endIndex }
 * @param param0
 * @returns
 */
function calculateRange({
  measurements,
  outerSize,
  scrollOffset, // 滚动偏移量，scrollLeft 或 scrollTop
  lanes,
}: {
  measurements: Array<VirtualItem>
  outerSize: number
  scrollOffset: number
  lanes: number
}) {
  // 最后一个item的索引
  const lastIndex = measurements.length - 1
  const getOffset = (index: number) => measurements[index]!.start

  // handle case when item count is less than or equal to lanes
  if (measurements.length <= lanes) {
    return {
      startIndex: 0,
      endIndex: lastIndex,
    }
  }

  /**
   * 找到 measurements[index]!.start == scrollOffset 时的indx
   */
  let startIndex = findNearestBinarySearch(
    0,
    lastIndex,
    getOffset,
    scrollOffset,
  )
  let endIndex = startIndex

  if (lanes === 1) {
    while (
      endIndex < lastIndex &&
      measurements[endIndex]!.end < scrollOffset + outerSize
    ) {
      endIndex++
    }
  } else if (lanes > 1) {
    // Expand forward until we include the visible items from all lanes
    // which are closer to the end of the virtualizer window
    const endPerLane = Array(lanes).fill(0)
    while (
      endIndex < lastIndex &&
      endPerLane.some((pos) => pos < scrollOffset + outerSize)
    ) {
      const item = measurements[endIndex]!
      endPerLane[item.lane] = item.end
      endIndex++
    }

    // Expand backward until we include all lanes' visible items
    // closer to the top
    const startPerLane = Array(lanes).fill(scrollOffset + outerSize)
    while (startIndex >= 0 && startPerLane.some((pos) => pos >= scrollOffset)) {
      const item = measurements[startIndex]!
      startPerLane[item.lane] = item.start
      startIndex--
    }

    // Align startIndex to the beginning of its lane
    startIndex = Math.max(0, startIndex - (startIndex % lanes))
    // Align endIndex to the end of its lane
    endIndex = Math.min(lastIndex, endIndex + (lanes - 1 - (endIndex % lanes)))
  }

  return { startIndex, endIndex }
}
