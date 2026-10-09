import { TestBed, ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signal, WritableSignal } from '@angular/core';
import { EMPTY } from 'rxjs';
import { RetroColumnComponent } from './retro-column.component';
import { RetroStateService } from '../../services/retro-state.service';
import { RetroWebSocketService } from '../../services/retro-websocket.service';
import { computeDropIndex } from './drop-index';
import { ColumnLayout, RetroCard, RetroColumn, RetroConfiguration } from '@shared/types';

/**
 * Task 18.7 moved the column's drop-index arithmetic into `drop-index.ts`, which
 * reads each card's measured `start`/`size` at drag time. These tests pin the
 * preserved drag start, drag over, drop indicator, move, merge and column
 * reorder behaviour with deliberately non-uniform card extents, for both the
 * vertical and the horizontal column layout (R6.13, R7.10).
 *
 * The test DOM performs no layout, so `getBoundingClientRect` is stubbed on each
 * rendered `app-retro-card` element to simulate the card strip.
 */

/** Off-axis pointer coordinate: reading it would pick the wrong axis. */
const OFF_AXIS = 9999;

function createMockCard(overrides: Partial<RetroCard> = {}): RetroCard {
  return {
    id: 'card-1',
    text: 'Test card text',
    authorId: 'user-1',
    authorName: 'Alice',
    votes: 0,
    votedBy: [],
    comments: [],
    columnId: 'col-1',
    order: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockConfig(layout: ColumnLayout): RetroConfiguration {
  return {
    boardName: 'Sprint 42',
    maxVotesPerUser: 6,
    templateId: 'default',
    hideCardsInitially: false,
    disableVotingInitially: false,
    hideVoteCount: false,
    oneVotePerCard: false,
    showCardAuthor: false,
    password: null,
    enableGifEmoji: true,
    columnLayout: layout,
    allowedFeelings: ['Happy', 'Sad', 'No_Feeling'],
    fluidCardHeight: true,
  };
}

/** col-1 holds the three cards under test; col-2 is the foreign source; col-3 is empty. */
function createMockColumns(): RetroColumn[] {
  return [
    {
      id: 'col-1',
      name: 'What went well',
      order: 0,
      cards: [
        createMockCard({ id: 'card-1', text: 'Card One', columnId: 'col-1', order: 0 }),
        createMockCard({ id: 'card-2', text: 'Card Two', columnId: 'col-1', order: 1 }),
        createMockCard({ id: 'card-3', text: 'Card Three', columnId: 'col-1', order: 2 }),
      ],
    },
    {
      id: 'col-2',
      name: 'What could be better',
      order: 1,
      cards: [createMockCard({ id: 'card-x', text: 'Foreign Card', columnId: 'col-2', order: 0 })],
    },
    { id: 'col-3', name: 'Action items', order: 2, cards: [] },
  ];
}

interface CardExtent {
  start: number;
  size: number;
}

/** Lays `sizes` end to end with a constant gap, as a flex column/row would. */
function layOutCards(sizes: readonly number[], gap: number): CardExtent[] {
  let cursor = 0;
  return sizes.map((size) => {
    const extent = { start: cursor, size };
    cursor += size + gap;
    return extent;
  });
}

interface LayoutCase {
  layout: ColumnLayout;
  isHorizontal: boolean;
  /** Non-uniform card extents along the layout axis. */
  sizes: number[];
  gap: number;
  /** `[pointer, expectedDropIndex]` pairs covering before, inside and after the strip. */
  pointerCases: Array<[number, number]>;
}

// vertical: starts 0 / 46 / 212, midpoints 20 / 126 / 248
// horizontal: starts 0 / 58 / 276, midpoints 25 / 163 / 321
const LAYOUT_CASES: LayoutCase[] = [
  {
    layout: 'vertical',
    isHorizontal: false,
    sizes: [40, 160, 72],
    gap: 6,
    pointerCases: [
      [10, 0],
      [100, 1],
      [200, 2],
      [400, 3],
    ],
  },
  {
    layout: 'horizontal',
    isHorizontal: true,
    sizes: [50, 210, 90],
    gap: 8,
    pointerCases: [
      [10, 0],
      [100, 1],
      [300, 2],
      [500, 3],
    ],
  },
];

function createDragEvent(options: {
  data?: Record<string, string>;
  types?: string[];
  pointer?: number;
  isHorizontal?: boolean;
  target?: EventTarget | null;
  relatedTarget?: EventTarget | null;
}): DragEvent {
  const data = options.data ?? {};
  const dataTransfer = {
    getData: (key: string) => data[key] ?? '',
    setData: (key: string, value: string) => {
      data[key] = value;
    },
    types: options.types ?? Object.keys(data),
    dropEffect: 'none',
    effectAllowed: 'none',
  } as unknown as DataTransfer;

  const pointer = options.pointer ?? 0;
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer,
    target: options.target ?? null,
    relatedTarget: options.relatedTarget ?? null,
    clientX: options.isHorizontal ? pointer : OFF_AXIS,
    clientY: options.isHorizontal ? OFF_AXIS : pointer,
  } as unknown as DragEvent;
}

/** Dispatches a real bubbling drag event so the template bindings run. */
function dispatchDragEvent(
  element: Element,
  type: 'dragstart' | 'dragend',
  data: Record<string, string> = {}
): void {
  const event = new Event(type, { bubbles: true });
  const dataTransfer = {
    getData: (key: string) => data[key] ?? '',
    setData: (key: string, value: string) => {
      data[key] = value;
    },
    types: Object.keys(data),
    dropEffect: 'none',
    effectAllowed: 'none',
  };
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  element.dispatchEvent(event);
}

describe('RetroColumnComponent drag and drop (non-uniform card extents)', () => {
  let fixture: ComponentFixture<RetroColumnComponent>;
  let component: RetroColumnComponent;
  let columnsSignal: WritableSignal<RetroColumn[]>;
  let configSignal: WritableSignal<RetroConfiguration | null>;
  let isCompletedSignal: WritableSignal<boolean>;
  let mockWsService: {
    sendCardMove: ReturnType<typeof vi.fn>;
    sendCardMerge: ReturnType<typeof vi.fn>;
    sendColumnReorder: ReturnType<typeof vi.fn>;
    [key: string]: unknown;
  };

  function setUpColumn(layout: ColumnLayout, columnId = 'col-1'): void {
    columnsSignal = signal<RetroColumn[]>(createMockColumns());
    configSignal = signal<RetroConfiguration | null>(createMockConfig(layout));
    isCompletedSignal = signal(false);

    const mockRetroState = {
      isCompleted: isCompletedSignal.asReadonly(),
      isModerator: signal(false).asReadonly(),
      columns: columnsSignal.asReadonly(),
      cardsRevealed: signal(true).asReadonly(),
      currentUserId: signal('user-1').asReadonly(),
      config: configSignal.asReadonly(),
      lastAddedOwnCardId: signal<string | null>(null),
      ownNewCardIds: signal(new Set<string>()).asReadonly(),
      votingEnabled: signal(true).asReadonly(),
      votesRemaining: signal(5).asReadonly(),
    };

    mockWsService = {
      send: vi.fn(),
      on: vi.fn().mockReturnValue(EMPTY),
      sendCardAdd: vi.fn(),
      sendCardEdit: vi.fn(),
      sendCardRemove: vi.fn(),
      sendCardMove: vi.fn(),
      sendCardVote: vi.fn(),
      sendCardMerge: vi.fn(),
      sendColumnRemove: vi.fn(),
      sendColumnReorder: vi.fn(),
      sendCommentAdd: vi.fn(),
      sendCommentRemove: vi.fn(),
    };

    TestBed.configureTestingModule({
      imports: [RetroColumnComponent],
      providers: [
        { provide: RetroStateService, useValue: mockRetroState },
        { provide: RetroWebSocketService, useValue: mockWsService },
      ],
    });

    fixture = TestBed.createComponent(RetroColumnComponent);
    const column = columnsSignal().find((c) => c.id === columnId)!;
    fixture.componentRef.setInput('column', column);
    fixture.detectChanges();
    component = fixture.componentInstance;
  }

  function cardsContainer(): HTMLElement {
    return fixture.nativeElement.querySelector('.retro-column__cards') as HTMLElement;
  }

  function cardElements(): HTMLElement[] {
    return Array.from(cardsContainer().querySelectorAll('app-retro-card'));
  }

  /** Simulates the measured card strip; the test DOM returns zeroed rects otherwise. */
  function stubCardExtents(extents: readonly CardExtent[], isHorizontal: boolean): HTMLElement[] {
    const elements = cardElements();
    expect(elements.length).toBe(extents.length);

    elements.forEach((element, index) => {
      const { start, size } = extents[index];
      const rect = isHorizontal
        ? { x: start, y: 0, left: start, right: start + size, width: size, top: 0, bottom: 120, height: 120 }
        : { x: 0, y: start, left: 0, right: 280, width: 280, top: start, bottom: start + size, height: size };
      element.getBoundingClientRect = () =>
        ({ ...rect, toJSON: () => rect }) as DOMRect;
    });

    return elements;
  }

  function dropIndicator(): HTMLElement | null {
    return cardsContainer().querySelector('.retro-drop-indicator');
  }

  /** Child position of the indicator, which equals the computed drop index. */
  function indicatorPosition(): number {
    const indicator = dropIndicator();
    expect(indicator).not.toBeNull();
    return Array.from(cardsContainer().children).indexOf(indicator!);
  }

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  for (const layoutCase of LAYOUT_CASES) {
    const { layout, isHorizontal, sizes, gap, pointerCases } = layoutCase;
    const extents = layOutCards(sizes, gap);

    describe(`${layout} layout`, () => {
      beforeEach(() => {
        setUpColumn(layout);
      });

      it('exposes the layout to the host so the card axis matches the configuration', () => {
        expect(component.isHorizontalLayout()).toBe(isHorizontal);
        expect((fixture.nativeElement as HTMLElement).classList.contains('is-horizontal')).toBe(
          isHorizontal
        );
      });

      it('publishes the dragged card id on drag start', () => {
        stubCardExtents(extents, isHorizontal);
        const data: Record<string, string> = {};
        const firstCard = cardElements()[0].querySelector('.retro-card') as HTMLElement;

        dispatchDragEvent(firstCard, 'dragstart', data);

        expect(data['text/retro-card-id']).toBe('card-1');
        expect(data['text/retro-source-column-id']).toBe('col-1');
        expect(firstCard.classList.contains('dragging')).toBe(true);

        dispatchDragEvent(firstCard, 'dragend', data);
        expect(firstCard.classList.contains('dragging')).toBe(false);
      });

      it('publishes the dragged column id on header drag start', () => {
        const data: Record<string, string> = {};
        const header = fixture.nativeElement.querySelector('.retro-column__header') as HTMLElement;

        dispatchDragEvent(header, 'dragstart', data);

        expect(data['text/retro-column-id']).toBe('col-1');
        expect(data['text/retro-card-id']).toBeUndefined();
      });

      it.each(pointerCases)(
        'places the drop indicator at the midpoint boundary (pointer %i → index %i)',
        (pointer, expectedIndex) => {
          stubCardExtents(extents, isHorizontal);

          component.onDragOver(
            createDragEvent({
              types: ['text/retro-card-id'],
              data: { 'text/retro-card-id': 'card-x' },
              pointer,
              isHorizontal,
            })
          );

          expect(computeDropIndex(extents, pointer)).toBe(expectedIndex);
          expect(indicatorPosition()).toBe(expectedIndex);
        }
      );

      it('keeps exactly one drop indicator across successive drag over events', () => {
        stubCardExtents(extents, isHorizontal);

        for (const [pointer, expectedIndex] of pointerCases) {
          component.onDragOver(
            createDragEvent({
              types: ['text/retro-card-id'],
              data: { 'text/retro-card-id': 'card-x' },
              pointer,
              isHorizontal,
            })
          );

          expect(cardsContainer().querySelectorAll('.retro-drop-indicator').length).toBe(1);
          expect(indicatorPosition()).toBe(expectedIndex);
        }
      });

      it('highlights the column and shows no card indicator while a column is dragged over', () => {
        stubCardExtents(extents, isHorizontal);

        component.onDragOver(
          createDragEvent({
            types: ['text/retro-column-id'],
            data: { 'text/retro-column-id': 'col-2' },
            pointer: 100,
            isHorizontal,
          })
        );

        const columnEl = fixture.nativeElement.querySelector('.retro-column') as HTMLElement;
        expect(columnEl.classList.contains('drag-over')).toBe(true);
        expect(dropIndicator()).toBeNull();
      });

      it('clears the highlight and the indicator when the pointer leaves the column', () => {
        stubCardExtents(extents, isHorizontal);
        const columnEl = fixture.nativeElement.querySelector('.retro-column') as HTMLElement;
        columnEl.classList.add('drag-over');
        component.onDragOver(
          createDragEvent({
            types: ['text/retro-card-id'],
            data: { 'text/retro-card-id': 'card-x' },
            pointer: 100,
            isHorizontal,
          })
        );
        expect(dropIndicator()).not.toBeNull();

        component.onDragLeave(createDragEvent({ relatedTarget: null, isHorizontal }));

        expect(columnEl.classList.contains('drag-over')).toBe(false);
        expect(dropIndicator()).toBeNull();
      });

      it.each(pointerCases)(
        'moves a card from another column to the measured index (pointer %i → index %i)',
        (pointer, expectedIndex) => {
          stubCardExtents(extents, isHorizontal);

          component.onDrop(
            createDragEvent({
              types: ['text/retro-card-id'],
              data: { 'text/retro-card-id': 'card-x' },
              pointer,
              isHorizontal,
            })
          );

          expect(mockWsService.sendCardMove).toHaveBeenCalledWith('card-x', 'col-1', expectedIndex);
        }
      );

      it('shifts the index down by one for a same-column move past the dragged card', () => {
        stubCardExtents(extents, isHorizontal);
        const [, lastExpected] = pointerCases[pointerCases.length - 1];
        const pointer = pointerCases[pointerCases.length - 1][0];

        // card-1 sits at index 0 of this column, so every later index shifts down.
        component.onDrop(
          createDragEvent({
            types: ['text/retro-card-id'],
            data: { 'text/retro-card-id': 'card-1' },
            pointer,
            isHorizontal,
          })
        );

        expect(mockWsService.sendCardMove).toHaveBeenCalledWith(
          'card-1',
          'col-1',
          lastExpected - 1
        );
      });

      it('leaves the index unchanged for a same-column move before the dragged card', () => {
        stubCardExtents(extents, isHorizontal);

        // card-3 sits at index 2; dropping before the first midpoint yields index 0.
        component.onDrop(
          createDragEvent({
            types: ['text/retro-card-id'],
            data: { 'text/retro-card-id': 'card-3' },
            pointer: pointerCases[0][0],
            isHorizontal,
          })
        );

        expect(mockWsService.sendCardMove).toHaveBeenCalledWith('card-3', 'col-1', 0);
      });

      it('removes the indicator after a drop', () => {
        stubCardExtents(extents, isHorizontal);
        component.onDragOver(
          createDragEvent({
            types: ['text/retro-card-id'],
            data: { 'text/retro-card-id': 'card-x' },
            pointer: 100,
            isHorizontal,
          })
        );
        expect(dropIndicator()).not.toBeNull();

        component.onDrop(
          createDragEvent({
            types: ['text/retro-card-id'],
            data: { 'text/retro-card-id': 'card-x' },
            pointer: 100,
            isHorizontal,
          })
        );

        expect(dropIndicator()).toBeNull();
      });

      it('opens the merge popup for a card dropped onto a rendered card', () => {
        const elements = stubCardExtents(extents, isHorizontal);
        const secondCardEl = elements[1].querySelector('.retro-card') as HTMLElement;

        component.onDrop(
          createDragEvent({
            types: ['text/retro-card-id'],
            data: { 'text/retro-card-id': 'card-1' },
            pointer: 100,
            isHorizontal,
            target: secondCardEl,
          })
        );
        fixture.detectChanges();

        expect(component.showMergePopup()).toBe(true);
        expect(component.mergeSourceCardText()).toBe('Card One');
        expect(component.mergeTargetCardText()).toBe('Card Two');
        expect(mockWsService.sendCardMove).not.toHaveBeenCalled();

        component.onMergeConfirmed();
        expect(mockWsService.sendCardMerge).toHaveBeenCalledWith('card-1', 'card-2');
      });

      it('does not merge onto a rendered card while the board is completed', () => {
        const elements = stubCardExtents(extents, isHorizontal);
        const secondCardEl = elements[1].querySelector('.retro-card') as HTMLElement;
        isCompletedSignal.set(true);
        fixture.detectChanges();

        component.onDrop(
          createDragEvent({
            types: ['text/retro-card-id'],
            data: { 'text/retro-card-id': 'card-1' },
            pointer: 100,
            isHorizontal,
            target: secondCardEl,
          })
        );

        expect(component.showMergePopup()).toBe(false);
        expect(mockWsService.sendCardMerge).not.toHaveBeenCalled();
        expect(mockWsService.sendCardMove).not.toHaveBeenCalled();
      });

      it('reorders columns when a column is dropped onto this one', () => {
        stubCardExtents(extents, isHorizontal);

        component.onDrop(
          createDragEvent({
            types: ['text/retro-column-id'],
            data: { 'text/retro-column-id': 'col-3' },
            pointer: 100,
            isHorizontal,
          })
        );

        expect(mockWsService.sendColumnReorder).toHaveBeenCalledWith(['col-3', 'col-1', 'col-2']);
        expect(mockWsService.sendCardMove).not.toHaveBeenCalled();
      });

      it('ignores a column dropped onto itself', () => {
        stubCardExtents(extents, isHorizontal);

        component.onDrop(
          createDragEvent({
            types: ['text/retro-column-id'],
            data: { 'text/retro-column-id': 'col-1' },
            pointer: 100,
            isHorizontal,
          })
        );

        expect(mockWsService.sendColumnReorder).not.toHaveBeenCalled();
      });

      it('drops into an empty column at index 0', () => {
        TestBed.resetTestingModule();
        setUpColumn(layout, 'col-3');
        expect(cardElements().length).toBe(0);

        component.onDragOver(
          createDragEvent({
            types: ['text/retro-card-id'],
            data: { 'text/retro-card-id': 'card-x' },
            pointer: 400,
            isHorizontal,
          })
        );
        expect(indicatorPosition()).toBe(0);

        component.onDrop(
          createDragEvent({
            types: ['text/retro-card-id'],
            data: { 'text/retro-card-id': 'card-x' },
            pointer: 400,
            isHorizontal,
          })
        );

        expect(mockWsService.sendCardMove).toHaveBeenCalledWith('card-x', 'col-3', 0);
      });
    });
  }

  it('reads the vertical axis for a vertical column and the horizontal axis for a horizontal one', () => {
    // Same extents, same pointer: only the configured axis decides the index.
    const verticalExtents = layOutCards([40, 160, 72], 6);

    setUpColumn('vertical');
    stubCardExtents(verticalExtents, false);
    component.onDrop(
      createDragEvent({
        types: ['text/retro-card-id'],
        data: { 'text/retro-card-id': 'card-x' },
        pointer: 100,
        isHorizontal: false,
      })
    );
    expect(mockWsService.sendCardMove).toHaveBeenCalledWith('card-x', 'col-1', 1);

    TestBed.resetTestingModule();
    setUpColumn('horizontal');
    stubCardExtents(verticalExtents, true);
    component.onDrop(
      createDragEvent({
        types: ['text/retro-card-id'],
        data: { 'text/retro-card-id': 'card-x' },
        pointer: 100,
        isHorizontal: true,
      })
    );
    expect(mockWsService.sendCardMove).toHaveBeenCalledWith('card-x', 'col-1', 1);
  });
});
