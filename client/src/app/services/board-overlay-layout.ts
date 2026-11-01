/**
 * Pure geometry of the fixed-position overlays on a Board_Page (design "Overlay geometry model",
 * R4.2, R12.3, R12.4, R12.9, R12.11, R12.12, R20.14).
 *
 * The chat elements (Chat_Launcher, open Chat_Panel, minimized Panel_Header and
 * Chat_Load_Error_Notice) sit in the bottom-right corner. The poker Vote_Callout_Layer sits in the
 * bottom-left corner at the Bottom_Left_Base_Offset, and the Moderator_Note_Balloon stack sits
 * directly above it. `BoardOverlayLayoutService` and the geometry property test both use these
 * functions, so the numbers below are the single source for the arrangement.
 *
 * Coordinates are CSS pixels in the viewport, origin top-left, matching `getBoundingClientRect()`.
 * "Offsets" (base offset, balloon bottom) are distances from the viewport's bottom edge, matching
 * the CSS `bottom` property. No Angular, no DOM.
 */

/** Below this width the Narrow_Viewport layout applies (the existing `max-width: 767px` rule). */
export const NARROW_BREAKPOINT_PX = 768;

/** Distance of every anchored overlay from the viewport edge it is anchored to. */
export const EDGE_GAP_PX = 16;
/** Gap between stacked overlays, and between the chat elements and the launcher top. */
export const STACK_GAP_PX = 8;

/** Chat_Launcher diameter on a Wide_Viewport and a Narrow_Viewport. */
export const LAUNCHER_SIZE_WIDE_PX = 56;
export const LAUNCHER_SIZE_NARROW_PX = 48;
/**
 * Furthest the launcher's decorations reach beyond its edge: the focus ring (3 px + 3 px box
 * shadow) and the attention pulse at scale 1.25 of a 56 px circle both stay within 7 px.
 */
export const LAUNCHER_RING_EXTENT_PX = 7;

/** Width of the open Chat_Panel, and of the minimized header / notice on a Wide_Viewport. */
export const CHAT_PANEL_WIDTH_PX = 360;
/** The open Chat_Panel is at most `min(520px, 70vh)` tall (R4.1). */
export const CHAT_PANEL_MAX_HEIGHT_PX = 520;
export const CHAT_PANEL_MAX_HEIGHT_RATIO = 0.7;

/** Bottom-left arrangement widths: wide caps (R12.3, R12.4) and the narrow `calc(100vw - 88px)`. */
export const BOTTOM_LEFT_MAX_WIDTH_WIDE_PX = 360;
export const BOTTOM_LEFT_NARROW_WIDTH_INSET_PX = 88;
/** Wide layer cap `calc(100vw - 16px)` and wide balloon cap `calc(100vw - 32px)`. */
export const CALLOUT_LAYER_WIDE_WIDTH_INSET_PX = 16;
export const BALLOON_WIDE_WIDTH_INSET_PX = 32;

/** Vote_Callout_Layer `max-height`: 40vh wide (vote-reveal R7.7), 45vh narrow (R8.2). */
export const CALLOUT_LAYER_MAX_HEIGHT_RATIO_WIDE = 0.4;
export const CALLOUT_LAYER_MAX_HEIGHT_RATIO_NARROW = 0.45;

/** Moderator_Note_Balloon stack `max-height: 50vh` (R12.4). */
export const BALLOON_MAX_HEIGHT_RATIO = 0.5;
/** The balloon stack is hidden when less than this much height is left for it (R12.11). */
export const BALLOON_MIN_VISIBLE_HEIGHT_PX = 64;

/** Display state of the Chat_Panel. */
export type PanelState = 'closed' | 'open' | 'minimized';

/** An axis-aligned box in viewport CSS pixels (`right >= left`, `bottom >= top`). */
export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Everything the geometry depends on. Heights are measured with `ResizeObserver`. */
export interface OverlayLayoutInput {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** True below {@link NARROW_BREAKPOINT_PX}; see {@link isNarrowViewport}. */
  readonly narrow: boolean;
  readonly panelState: PanelState;
  /** Whether the Chat_Load_Error_Notice is shown. */
  readonly noticeShown: boolean;
  /** Bottom edge of the Board_Page header, from the viewport top. */
  readonly headerBottomPx: number;
  /** Measured height of the Vote_Callout_Layer; 0 when no callout is visible. */
  readonly calloutLayerHeightPx: number;
  /** Measured height of the minimized Panel_Header. */
  readonly minimizedHeaderHeightPx: number;
  /** Measured height of the Chat_Load_Error_Notice. */
  readonly noticeHeightPx: number;
}

/** Rectangles of every overlay; `null` for an element that is not rendered. */
export interface OverlayLayout {
  /** Bottom_Left_Base_Offset, from the viewport bottom. */
  readonly baseOffsetPx: number;
  /** Bottom of the balloon stack, from the viewport bottom. */
  readonly balloonBottomPx: number;
  readonly balloonMaxHeightPx: number;
  readonly balloonHidden: boolean;
  /** The launcher including its 7 px ring extent; `null` on a narrow viewport while `open`. */
  readonly launcher: Rect | null;
  readonly openPanel: Rect | null;
  readonly minimizedHeader: Rect | null;
  readonly loadErrorNotice: Rect | null;
  /** The Vote_Callout_Layer at its maximum width and its (clamped) measured height; `null` when empty. */
  readonly calloutLayer: Rect | null;
  /** The balloon stack at its maximum size; `null` while hidden. */
  readonly balloonStack: Rect | null;
}

export function isNarrowViewport(viewportWidth: number): boolean {
  return viewportWidth < NARROW_BREAKPOINT_PX;
}

/** True when the two boxes share an area; touching edges do not count. */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

// ---- Formulas used by BoardOverlayLayoutService ------------------------------------------------

/**
 * Bottom_Left_Base_Offset: 16 px, except on a Narrow_Viewport while the minimized Panel_Header or
 * the Chat_Load_Error_Notice is shown, where it reaches a line 8 px above that element's top
 * (R12.12). `chatDockTopPx` is that top edge from the viewport top, or `null` when neither shows.
 */
export function bottomLeftBaseOffset(
  narrow: boolean,
  viewportHeight: number,
  chatDockTopPx: number | null
): number {
  return narrow && chatDockTopPx !== null
    ? viewportHeight - chatDockTopPx + STACK_GAP_PX
    : EDGE_GAP_PX;
}

/**
 * Bottom of the balloon stack from the viewport bottom: 8 px above the Vote_Callout_Layer's top
 * while a callout is visible, otherwise the base offset (R12.4). The layer's bottom is the base
 * offset.
 */
export function balloonBottom(baseOffsetPx: number, calloutLayerHeightPx: number): number {
  return calloutLayerHeightPx > 0
    ? baseOffsetPx + calloutLayerHeightPx + STACK_GAP_PX
    : baseOffsetPx;
}

/** `min(50vh, space between the stack bottom and a line 8 px below the header)` (R12.4). */
export function balloonMaxHeight(
  viewportHeight: number,
  balloonBottomPx: number,
  headerBottomPx: number
): number {
  return Math.min(
    BALLOON_MAX_HEIGHT_RATIO * viewportHeight,
    viewportHeight - balloonBottomPx - (headerBottomPx + STACK_GAP_PX)
  );
}

/** The stack is hidden while less than 64 px is left for it (R12.11). */
export function isBalloonHidden(balloonMaxHeightPx: number): boolean {
  return balloonMaxHeightPx < BALLOON_MIN_VISIBLE_HEIGHT_PX;
}

// ---- Widths and heights ------------------------------------------------------------------------

export function launcherSize(narrow: boolean): number {
  return narrow ? LAUNCHER_SIZE_NARROW_PX : LAUNCHER_SIZE_WIDE_PX;
}

/** Wide: `min(360px, calc(100vw - 16px))`; narrow: `calc(100vw - 88px)` (R12.3). */
export function calloutLayerMaxWidth(viewportWidth: number, narrow: boolean): number {
  return narrow
    ? viewportWidth - BOTTOM_LEFT_NARROW_WIDTH_INSET_PX
    : Math.min(BOTTOM_LEFT_MAX_WIDTH_WIDE_PX, viewportWidth - CALLOUT_LAYER_WIDE_WIDTH_INSET_PX);
}

/** Wide: `40vh`; narrow: `45vh` (R12.3). */
export function calloutLayerMaxHeight(viewportHeight: number, narrow: boolean): number {
  return (
    viewportHeight *
    (narrow ? CALLOUT_LAYER_MAX_HEIGHT_RATIO_NARROW : CALLOUT_LAYER_MAX_HEIGHT_RATIO_WIDE)
  );
}

/** Wide: `min(360px, calc(100vw - 32px))`; narrow: `calc(100vw - 88px)` (R12.4). */
export function balloonMaxWidth(viewportWidth: number, narrow: boolean): number {
  return narrow
    ? viewportWidth - BOTTOM_LEFT_NARROW_WIDTH_INSET_PX
    : Math.min(BOTTOM_LEFT_MAX_WIDTH_WIDE_PX, viewportWidth - BALLOON_WIDE_WIDTH_INSET_PX);
}

/** Width of the minimized Panel_Header and the Chat_Load_Error_Notice (R4.9, R20.14). */
export function chatDockWidth(viewportWidth: number, narrow: boolean): number {
  return narrow ? viewportWidth - 2 * EDGE_GAP_PX : CHAT_PANEL_WIDTH_PX;
}

// ---- Rectangles --------------------------------------------------------------------------------

/** The launcher circle itself, fixed at `right: 16px; bottom: 16px`. */
export function launcherBox(viewportWidth: number, viewportHeight: number, narrow: boolean): Rect {
  const size = launcherSize(narrow);
  const right = viewportWidth - EDGE_GAP_PX;
  const bottom = viewportHeight - EDGE_GAP_PX;
  return { left: right - size, top: bottom - size, right, bottom };
}

/** The launcher grown by its 7 px ring extent on every side. */
export function launcherRect(viewportWidth: number, viewportHeight: number, narrow: boolean): Rect {
  const box = launcherBox(viewportWidth, viewportHeight, narrow);
  return {
    left: box.left - LAUNCHER_RING_EXTENT_PX,
    top: box.top - LAUNCHER_RING_EXTENT_PX,
    right: box.right + LAUNCHER_RING_EXTENT_PX,
    bottom: box.bottom + LAUNCHER_RING_EXTENT_PX,
  };
}

/**
 * Box docked above the launcher: bottom 8 px above the launcher's top, right edge 16 px from the
 * viewport's right edge. Used for the minimized Panel_Header and the Chat_Load_Error_Notice.
 */
export function chatDockRect(
  viewportWidth: number,
  viewportHeight: number,
  narrow: boolean,
  heightPx: number
): Rect {
  const right = viewportWidth - EDGE_GAP_PX;
  const bottom = launcherBox(viewportWidth, viewportHeight, narrow).top - STACK_GAP_PX;
  return {
    left: right - chatDockWidth(viewportWidth, narrow),
    top: bottom - Math.max(0, heightPx),
    right,
    bottom,
  };
}

/**
 * The open Chat_Panel. Narrow: the whole viewport (R4.3). Wide: 360 px wide at right 16, bottom
 * 8 px above the launcher, at most `min(520px, 70vh)` tall and with its top at least 8 px below
 * the header (R4.1, R4.2).
 */
export function openPanelRect(
  viewportWidth: number,
  viewportHeight: number,
  narrow: boolean,
  headerBottomPx: number
): Rect {
  if (narrow) return { left: 0, top: 0, right: viewportWidth, bottom: viewportHeight };
  const right = viewportWidth - EDGE_GAP_PX;
  const bottom = launcherBox(viewportWidth, viewportHeight, narrow).top - STACK_GAP_PX;
  const height = Math.max(
    0,
    Math.min(
      CHAT_PANEL_MAX_HEIGHT_PX,
      CHAT_PANEL_MAX_HEIGHT_RATIO * viewportHeight,
      bottom - (headerBottomPx + STACK_GAP_PX)
    )
  );
  return { left: right - CHAT_PANEL_WIDTH_PX, top: bottom - height, right, bottom };
}

/** Top edge of the minimized header or the notice on a Narrow_Viewport, else `null`. */
export function chatDockTop(input: OverlayLayoutInput): number | null {
  if (!input.narrow) return null;
  const { viewportWidth: w, viewportHeight: h, narrow } = input;
  const tops: number[] = [];
  if (input.panelState === 'minimized') {
    tops.push(chatDockRect(w, h, narrow, input.minimizedHeaderHeightPx).top);
  }
  if (input.noticeShown) tops.push(chatDockRect(w, h, narrow, input.noticeHeightPx).top);
  return tops.length === 0 ? null : Math.min(...tops);
}

/** Computes every overlay rectangle and the balloon stack values for one input. */
export function computeOverlayLayout(input: OverlayLayoutInput): OverlayLayout {
  const { viewportWidth: w, viewportHeight: h, narrow, panelState } = input;

  const baseOffsetPx = bottomLeftBaseOffset(narrow, h, chatDockTop(input));
  const layerHeight = Math.min(
    Math.max(0, input.calloutLayerHeightPx),
    calloutLayerMaxHeight(h, narrow)
  );
  const balloonBottomPx = balloonBottom(baseOffsetPx, layerHeight);
  const balloonMaxHeightPx = balloonMaxHeight(h, balloonBottomPx, input.headerBottomPx);
  const balloonHidden = isBalloonHidden(balloonMaxHeightPx);

  const layerBottomY = h - baseOffsetPx;
  const calloutLayer: Rect | null =
    layerHeight > 0
      ? {
          left: EDGE_GAP_PX,
          top: layerBottomY - layerHeight,
          right: EDGE_GAP_PX + calloutLayerMaxWidth(w, narrow),
          bottom: layerBottomY,
        }
      : null;

  const stackBottomY = h - balloonBottomPx;
  const balloonStack: Rect | null = balloonHidden
    ? null
    : {
        left: EDGE_GAP_PX,
        top: stackBottomY - balloonMaxHeightPx,
        right: EDGE_GAP_PX + balloonMaxWidth(w, narrow),
        bottom: stackBottomY,
      };

  return {
    baseOffsetPx,
    balloonBottomPx,
    balloonMaxHeightPx,
    balloonHidden,
    launcher: narrow && panelState === 'open' ? null : launcherRect(w, h, narrow),
    openPanel: panelState === 'open' ? openPanelRect(w, h, narrow, input.headerBottomPx) : null,
    minimizedHeader:
      panelState === 'minimized' ? chatDockRect(w, h, narrow, input.minimizedHeaderHeightPx) : null,
    loadErrorNotice: input.noticeShown ? chatDockRect(w, h, narrow, input.noticeHeightPx) : null,
    calloutLayer,
    balloonStack,
  };
}
