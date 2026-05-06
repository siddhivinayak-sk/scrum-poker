import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { SessionResumeListComponent } from './session-resume-list.component';
import { BasePathService } from '../../services/base-path.service';
import { SessionSummary, DEFAULT_SESSION_CONFIG } from '@shared/types';

describe('SessionResumeListComponent', () => {
  let fixture: ComponentFixture<SessionResumeListComponent>;
  let component: SessionResumeListComponent;
  let httpTesting: HttpTestingController;
  let router: Router;

  function createSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
      sessionId: 'abc123',
      createdAt: '2024-01-15T10:00:00Z',
      lastActivityAt: '2024-01-15T11:30:00Z',
      completedRounds: 5,
      participantCount: 3,
      config: DEFAULT_SESSION_CONFIG,
      ...overrides,
    };
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [SessionResumeListComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: 'session/:id', component: SessionResumeListComponent }]),
        {
          provide: BasePathService,
          useValue: { getBasePath: () => '', getApiUrl: (path: string) => path },
        },
      ],
    });

    httpTesting = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    fixture = TestBed.createComponent(SessionResumeListComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    httpTesting.verify();
  });

  describe('displays sessions', () => {
    it('should display a list of sessions after fetching', () => {
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/mine');
      req.flush({
        sessions: [
          createSession({ sessionId: 'sess-1', completedRounds: 3 }),
          createSession({ sessionId: 'sess-2', completedRounds: 7 }),
        ],
      });
      fixture.detectChanges();

      const items = fixture.nativeElement.querySelectorAll('.session-resume-list__item');
      expect(items.length).toBe(2);
      expect(items[0].textContent).toContain('sess-1');
      expect(items[0].textContent).toContain('3 rounds');
      expect(items[1].textContent).toContain('sess-2');
      expect(items[1].textContent).toContain('7 rounds');
    });

    it('should show loading state initially', () => {
      fixture.detectChanges();

      const loading = fixture.nativeElement.querySelector('.session-resume-list__loading');
      expect(loading).toBeTruthy();
      expect(loading.textContent).toContain('Loading sessions');

      // Clean up pending request
      httpTesting.expectOne('/api/sessions/mine').flush({ sessions: [] });
    });
  });

  describe('handles empty state', () => {
    it('should not render the section when sessions array is empty', () => {
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/mine');
      req.flush({ sessions: [] });
      fixture.detectChanges();

      const section = fixture.nativeElement.querySelector('.session-resume-list');
      expect(section).toBeNull();
    });

    it('should not render the section on 401 error', () => {
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/mine');
      req.flush(null, { status: 401, statusText: 'Unauthorized' });
      fixture.detectChanges();

      const section = fixture.nativeElement.querySelector('.session-resume-list');
      expect(section).toBeNull();
      const error = fixture.nativeElement.querySelector('.session-resume-list__error');
      expect(error).toBeNull();
    });
  });

  describe('handles errors', () => {
    it('should show error message on server error', () => {
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/mine');
      req.flush(null, { status: 500, statusText: 'Server Error' });
      fixture.detectChanges();

      const error = fixture.nativeElement.querySelector('.session-resume-list__error');
      expect(error).toBeTruthy();
      expect(error.textContent).toContain('Failed to load sessions');
    });
  });

  describe('navigation', () => {
    it('should navigate to /session/{sessionId} when a session is clicked', () => {
      const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/mine');
      req.flush({ sessions: [createSession({ sessionId: 'my-session' })] });
      fixture.detectChanges();

      const btn = fixture.nativeElement.querySelector('.session-resume-list__btn');
      btn.click();

      expect(navigateSpy).toHaveBeenCalledWith(['/session', 'my-session']);
    });
  });

  describe('accessibility', () => {
    it('should have aria-label on resume buttons', () => {
      fixture.detectChanges();

      const req = httpTesting.expectOne('/api/sessions/mine');
      req.flush({ sessions: [createSession({ sessionId: 'test-sess' })] });
      fixture.detectChanges();

      const btn = fixture.nativeElement.querySelector('.session-resume-list__btn');
      expect(btn.getAttribute('aria-label')).toBe('Resume session test-sess');
    });
  });
});
