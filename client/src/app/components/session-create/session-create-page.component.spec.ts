import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { signal } from '@angular/core';
import { SessionCreatePageComponent } from './session-create-page.component';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { BasePathService } from '../../services/base-path.service';
import { User } from '@shared/types';

describe('SessionCreatePageComponent', () => {
  let component: SessionCreatePageComponent;
  let fixture: ComponentFixture<SessionCreatePageComponent>;
  let httpTesting: HttpTestingController;
  let router: Router;
  let authServiceMock: {
    getToken: ReturnType<typeof vi.fn>;
    getCurrentUser: ReturnType<typeof vi.fn>;
    login: ReturnType<typeof vi.fn>;
    validateSession: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
    getReturnTo: ReturnType<typeof vi.fn>;
    setReturnTo: ReturnType<typeof vi.fn>;
  };
  let toastServiceMock: { show: ReturnType<typeof vi.fn> };
  let basePathMock: { getBasePath: ReturnType<typeof vi.fn>; getApiUrl: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    authServiceMock = {
      getToken: vi.fn().mockReturnValue('test-token'),
      getCurrentUser: vi.fn().mockReturnValue(signal<User | null>(null)),
      login: vi.fn(),
      validateSession: vi.fn(),
      logout: vi.fn(),
      getReturnTo: vi.fn().mockReturnValue(null),
      setReturnTo: vi.fn(),
    };

    toastServiceMock = {
      show: vi.fn(),
    };

    basePathMock = {
      getBasePath: vi.fn().mockReturnValue(''),
      getApiUrl: vi.fn().mockImplementation((path: string) => path),
    };

    TestBed.configureTestingModule({
      imports: [SessionCreatePageComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: authServiceMock },
        { provide: ToastService, useValue: toastServiceMock },
        { provide: BasePathService, useValue: basePathMock },
      ],
    });

    fixture = TestBed.createComponent(SessionCreatePageComponent);
    component = fixture.componentInstance;
    httpTesting = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
    fixture.detectChanges();
  });

  afterEach(() => {
    httpTesting.verify();
  });

  describe('advanced settings grouping', () => {
    it('should have advanced settings collapsed by default', () => {
      expect(component.showAdvanced()).toBe(false);
      const el = fixture.nativeElement as HTMLElement;
      const advancedSection = el.querySelector('#advanced-settings');
      expect(advancedSection).toBeNull();
    });

    it('should toggle advanced settings when toggle button is clicked', () => {
      component.toggleAdvanced();
      fixture.detectChanges();

      expect(component.showAdvanced()).toBe(true);
      const el = fixture.nativeElement as HTMLElement;
      const advancedSection = el.querySelector('#advanced-settings');
      expect(advancedSection).toBeTruthy();
    });

    it('should collapse advanced settings when toggled again', () => {
      component.toggleAdvanced();
      fixture.detectChanges();
      expect(component.showAdvanced()).toBe(true);

      component.toggleAdvanced();
      fixture.detectChanges();
      expect(component.showAdvanced()).toBe(false);

      const el = fixture.nativeElement as HTMLElement;
      const advancedSection = el.querySelector('#advanced-settings');
      expect(advancedSection).toBeNull();
    });

    it('should have aria-expanded="false" on toggle button by default', () => {
      const el = fixture.nativeElement as HTMLElement;
      const toggleBtn = el.querySelector('.advanced-toggle');
      expect(toggleBtn?.getAttribute('aria-expanded')).toBe('false');
    });

    it('should have aria-expanded="true" when advanced settings are shown', () => {
      component.toggleAdvanced();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const toggleBtn = el.querySelector('.advanced-toggle');
      expect(toggleBtn?.getAttribute('aria-expanded')).toBe('true');
    });

    it('should show voting system select as primary visible field', () => {
      const el = fixture.nativeElement as HTMLElement;
      const select = el.querySelector('select#votingSystem');
      expect(select).toBeTruthy();
    });

    it('should hide reveal permission, issue permission, auto-reveal, and countdown when collapsed', () => {
      const el = fixture.nativeElement as HTMLElement;
      const revealRadios = el.querySelectorAll('input[type="radio"][formControlName="revealPermission"]');
      const issueRadios = el.querySelectorAll('input[type="radio"][formControlName="issuePermission"]');
      const autoReveal = el.querySelector('input[type="checkbox"][formControlName="autoReveal"]');
      const countdown = el.querySelector('input[type="checkbox"][formControlName="countdownAnimation"]');

      expect(revealRadios.length).toBe(0);
      expect(issueRadios.length).toBe(0);
      expect(autoReveal).toBeNull();
      expect(countdown).toBeNull();
    });

    it('should show all advanced fields when expanded', () => {
      component.toggleAdvanced();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const revealRadios = el.querySelectorAll('input[type="radio"][formControlName="revealPermission"]');
      const issueRadios = el.querySelectorAll('input[type="radio"][formControlName="issuePermission"]');
      const autoReveal = el.querySelector('input[type="checkbox"][formControlName="autoReveal"]');
      const countdown = el.querySelector('input[type="checkbox"][formControlName="countdownAnimation"]');

      expect(revealRadios.length).toBe(3);
      expect(issueRadios.length).toBe(3);
      expect(autoReveal).toBeTruthy();
      expect(countdown).toBeTruthy();
    });
  });

  describe('form rendering with all config options', () => {
    it('should create the component', () => {
      expect(component).toBeTruthy();
    });

    it('should render a voting system select with all four options', () => {
      const el = fixture.nativeElement as HTMLElement;
      const select = el.querySelector('select#votingSystem') as HTMLSelectElement;
      expect(select).toBeTruthy();

      const options = select.querySelectorAll('option');
      expect(options.length).toBe(4);

      const values = Array.from(options).map((o) => o.value);
      expect(values).toContain('fibonacci');
      expect(values).toContain('modified-fibonacci');
      expect(values).toContain('t-shirt');
      expect(values).toContain('power-of-2');
    });

    it('should render reveal permission radio group with three options', () => {
      component.toggleAdvanced();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const radios = el.querySelectorAll('input[type="radio"][formControlName="revealPermission"]');
      expect(radios.length).toBe(3);

      const values = Array.from(radios).map((r) => (r as HTMLInputElement).value);
      expect(values).toContain('moderator-only');
      expect(values).toContain('all-players');
      expect(values).toContain('select-specific');
    });

    it('should render issue permission radio group with three options', () => {
      component.toggleAdvanced();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const radios = el.querySelectorAll('input[type="radio"][formControlName="issuePermission"]');
      expect(radios.length).toBe(3);

      const values = Array.from(radios).map((r) => (r as HTMLInputElement).value);
      expect(values).toContain('moderator-only');
      expect(values).toContain('all-players');
      expect(values).toContain('select-specific');
    });

    it('should render auto-reveal checkbox', () => {
      component.toggleAdvanced();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const checkbox = el.querySelector('input[type="checkbox"][formControlName="autoReveal"]');
      expect(checkbox).toBeTruthy();
    });

    it('should render countdown animation checkbox', () => {
      component.toggleAdvanced();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const checkbox = el.querySelector('input[type="checkbox"][formControlName="countdownAnimation"]');
      expect(checkbox).toBeTruthy();
    });

    it('should render a submit button', () => {
      const el = fixture.nativeElement as HTMLElement;
      const btn = el.querySelector('button[type="submit"]');
      expect(btn).toBeTruthy();
      expect(btn?.textContent).toContain('Create Session');
    });
  });

  describe('default values', () => {
    it('should default voting system to fibonacci', () => {
      expect(component.sessionForm.get('votingSystem')?.value).toBe('fibonacci');
    });

    it('should default reveal permission to moderator-only', () => {
      expect(component.sessionForm.get('revealPermission')?.value).toBe('moderator-only');
    });

    it('should default issue permission to moderator-only', () => {
      expect(component.sessionForm.get('issuePermission')?.value).toBe('moderator-only');
    });

    it('should default auto-reveal to false', () => {
      expect(component.sessionForm.get('autoReveal')?.value).toBe(false);
    });

    it('should default countdown animation to true', () => {
      expect(component.sessionForm.get('countdownAnimation')?.value).toBe(true);
    });
  });

  describe('form submission', () => {
    it('should POST to /api/sessions with correct config on submit', () => {
      component.onSubmit();

      const req = httpTesting.expectOne('/api/sessions');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({
        config: {
          votingSystem: 'fibonacci',
          revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
          issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
          autoReveal: false,
          countdownAnimation: true,
        },
      });
      expect(req.request.headers.get('Authorization')).toBe('Bearer test-token');

      req.flush({ sessionId: 'abc12345', config: {}, createdAt: new Date().toISOString() });
    });

    it('should navigate to /session/{sessionId} on successful creation', () => {
      component.onSubmit();

      const req = httpTesting.expectOne('/api/sessions');
      req.flush({ sessionId: 'abc12345', config: {}, createdAt: new Date().toISOString() });

      expect(router.navigate).toHaveBeenCalledWith(['/session', 'abc12345']);
    });

    it('should send custom config values when form is changed', () => {
      component.sessionForm.patchValue({
        votingSystem: 't-shirt',
        revealPermission: 'all-players',
        issuePermission: 'select-specific',
        autoReveal: true,
        countdownAnimation: false,
      });

      component.onSubmit();

      const req = httpTesting.expectOne('/api/sessions');
      expect(req.request.body).toEqual({
        config: {
          votingSystem: 't-shirt',
          revealPermission: { mode: 'all-players', allowedUserIds: [] },
          issuePermission: { mode: 'select-specific', allowedUserIds: [] },
          autoReveal: true,
          countdownAnimation: false,
        },
      });

      req.flush({ sessionId: 'xyz99999', config: {}, createdAt: new Date().toISOString() });
    });

    it('should show error toast on API failure', () => {
      component.onSubmit();

      const req = httpTesting.expectOne('/api/sessions');
      req.flush({ error: 'Server error' }, { status: 500, statusText: 'Internal Server Error' });

      expect(toastServiceMock.show).toHaveBeenCalledWith('error', 'Failed to create session. Please try again.');
    });

    it('should reset isSubmitting on API failure', () => {
      component.onSubmit();
      expect(component.isSubmitting).toBe(true);

      const req = httpTesting.expectOne('/api/sessions');
      req.flush({ error: 'Server error' }, { status: 500, statusText: 'Internal Server Error' });

      expect(component.isSubmitting).toBe(false);
    });

    it('should set isSubmitting to true during submission', () => {
      component.onSubmit();
      expect(component.isSubmitting).toBe(true);

      // Clean up the pending request
      const req = httpTesting.expectOne('/api/sessions');
      req.flush({ sessionId: 'abc12345', config: {}, createdAt: new Date().toISOString() });
    });
  });

  describe('form validation', () => {
    it('should not submit when form is invalid', () => {
      component.sessionForm.get('votingSystem')?.setValue('');
      component.sessionForm.get('votingSystem')?.markAsTouched();
      fixture.detectChanges();

      component.onSubmit();

      httpTesting.expectNone('/api/sessions');
      expect(component.isSubmitting).toBe(false);
    });

    it('should have required validator on votingSystem', () => {
      component.sessionForm.get('votingSystem')?.setValue('');
      expect(component.sessionForm.get('votingSystem')?.hasError('required')).toBe(true);
    });

    it('should have required validator on revealPermission', () => {
      component.sessionForm.get('revealPermission')?.setValue('');
      expect(component.sessionForm.get('revealPermission')?.hasError('required')).toBe(true);
    });

    it('should have required validator on issuePermission', () => {
      component.sessionForm.get('issuePermission')?.setValue('');
      expect(component.sessionForm.get('issuePermission')?.hasError('required')).toBe(true);
    });
  });

  describe('accessibility', () => {
    it('should have a label for the voting system select', () => {
      const el = fixture.nativeElement as HTMLElement;
      const label = el.querySelector('label[for="votingSystem"]');
      expect(label).toBeTruthy();
      expect(label?.textContent).toContain('Voting System');
    });

    it('should have fieldsets with legends for reveal permission', () => {
      component.toggleAdvanced();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const fieldsets = el.querySelectorAll('fieldset');
      const legends = Array.from(fieldsets).map((fs) => fs.querySelector('legend')?.textContent?.trim());
      expect(legends).toContain('Reveal Permission');
    });

    it('should have fieldsets with legends for issue permission', () => {
      component.toggleAdvanced();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const fieldsets = el.querySelectorAll('fieldset');
      const legends = Array.from(fieldsets).map((fs) => fs.querySelector('legend')?.textContent?.trim());
      expect(legends).toContain('Issue Permission');
    });

    it('should have a fieldset with legend for additional options', () => {
      component.toggleAdvanced();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const fieldsets = el.querySelectorAll('fieldset');
      const legends = Array.from(fieldsets).map((fs) => fs.querySelector('legend')?.textContent?.trim());
      expect(legends).toContain('Additional Options');
    });

    it('should have aria-label on the form', () => {
      const el = fixture.nativeElement as HTMLElement;
      const form = el.querySelector('form');
      expect(form?.getAttribute('aria-label')).toBeTruthy();
    });

    it('should have aria-labels on all radio inputs', () => {
      component.toggleAdvanced();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const radios = el.querySelectorAll('input[type="radio"]');
      radios.forEach((radio) => {
        expect(radio.getAttribute('aria-label')).toBeTruthy();
      });
    });

    it('should have aria-labels on checkbox inputs', () => {
      component.toggleAdvanced();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const checkboxes = el.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach((cb) => {
        expect(cb.getAttribute('aria-label')).toBeTruthy();
      });
    });

    it('should have aria-label on the submit button', () => {
      const el = fixture.nativeElement as HTMLElement;
      const btn = el.querySelector('button[type="submit"]');
      expect(btn?.getAttribute('aria-label')).toBeTruthy();
    });

    it('should have aria-busy attribute on submit button reflecting isSubmitting state', () => {
      const el = fixture.nativeElement as HTMLElement;
      const btn = el.querySelector('button[type="submit"]');
      // When not submitting, aria-busy should be false
      expect(btn?.getAttribute('aria-busy')).toBe('false');
    });

    it('should have role="radiogroup" on permission radio groups', () => {
      component.toggleAdvanced();
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const radioGroups = el.querySelectorAll('[role="radiogroup"]');
      expect(radioGroups.length).toBe(2);
    });

    it('should have role="main" on the container', () => {
      const el = fixture.nativeElement as HTMLElement;
      const main = el.querySelector('[role="main"]');
      expect(main).toBeTruthy();
    });

    it('should have aria-label on the voting system select', () => {
      const el = fixture.nativeElement as HTMLElement;
      const select = el.querySelector('select#votingSystem');
      expect(select?.getAttribute('aria-label')).toBeTruthy();
    });
  });
});
