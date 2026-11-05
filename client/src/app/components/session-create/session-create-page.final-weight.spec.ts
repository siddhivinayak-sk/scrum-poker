import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { SessionCreatePageComponent } from './session-create-page.component';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { BasePathService } from '../../services/base-path.service';
import { User } from '@shared/types';

/** Validates: Requirements 1 (final weight toggle on the create form) */
describe('SessionCreatePageComponent - final weight toggle', () => {
  let component: SessionCreatePageComponent;
  let fixture: ComponentFixture<SessionCreatePageComponent>;
  let httpTesting: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [SessionCreatePageComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: AuthService,
          useValue: {
            getToken: vi.fn().mockReturnValue('test-token'),
            getCurrentUser: vi.fn().mockReturnValue(signal<User | null>(null)),
          },
        },
        { provide: ToastService, useValue: { show: vi.fn() } },
        {
          provide: BasePathService,
          useValue: {
            getBasePath: vi.fn().mockReturnValue(''),
            getApiUrl: vi.fn().mockImplementation((p: string) => p),
          },
        },
      ],
    });

    fixture = TestBed.createComponent(SessionCreatePageComponent);
    component = fixture.componentInstance;
    httpTesting = TestBed.inject(HttpTestingController);
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture.detectChanges();
  });

  afterEach(() => {
    httpTesting.verify();
  });

  function getCheckbox(name: string): HTMLInputElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector(
      `input[type="checkbox"][formControlName="${name}"]`
    );
  }

  function openAdvanced(): void {
    component.toggleAdvanced();
    fixture.detectChanges();
  }

  function submitAndFlush(): Record<string, unknown> {
    component.onSubmit();
    const req = httpTesting.expectOne('/api/sessions');
    const config = req.request.body.config as Record<string, unknown>;
    req.flush({ sessionId: 'abc12345', config: {}, createdAt: new Date().toISOString() });
    return config;
  }

  it('is hidden while advanced settings are collapsed', () => {
    expect(getCheckbox('finalWeightEnabled')).toBeNull();
  });

  it('renders an unchecked checkbox by default when advanced settings are open', () => {
    openAdvanced();
    const cb = getCheckbox('finalWeightEnabled');
    expect(cb).toBeTruthy();
    expect(cb?.checked).toBe(false);
    expect(component.sessionForm.get('finalWeightEnabled')?.value).toBe(false);
    expect(cb?.getAttribute('aria-label')).toBeTruthy();
  });

  it('submits finalWeightEnabled false when left untouched', () => {
    const config = submitAndFlush();
    expect(config['finalWeightEnabled']).toBe(false);
  });

  it('submits finalWeightEnabled true after the user checks the box', () => {
    openAdvanced();
    const cb = getCheckbox('finalWeightEnabled') as HTMLInputElement;
    cb.click();
    fixture.detectChanges();
    expect(component.sessionForm.get('finalWeightEnabled')?.value).toBe(true);

    const config = submitAndFlush();
    expect(config['finalWeightEnabled']).toBe(true);
  });

  it('submits finalWeightEnabled false after checking and unchecking', () => {
    openAdvanced();
    const cb = getCheckbox('finalWeightEnabled') as HTMLInputElement;
    cb.click();
    cb.click();
    fixture.detectChanges();

    const config = submitAndFlush();
    expect(config['finalWeightEnabled']).toBe(false);
  });

  it('leaves existing toggles and their payload keys unchanged', () => {
    openAdvanced();
    expect(getCheckbox('autoReveal')?.checked).toBe(false);
    expect(getCheckbox('countdownAnimation')?.checked).toBe(true);

    component.sessionForm.patchValue({ finalWeightEnabled: true, autoReveal: true, countdownAnimation: false });
    const config = submitAndFlush();
    expect(config).toEqual({
      votingSystem: 'fibonacci',
      revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
      issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
      autoReveal: true,
      countdownAnimation: false,
      finalWeightEnabled: true,
    });
  });

  it('toggling final weight does not change other controls', () => {
    openAdvanced();
    const before = { ...component.sessionForm.value };
    (getCheckbox('finalWeightEnabled') as HTMLInputElement).click();
    expect(component.sessionForm.value).toEqual({ ...before, finalWeightEnabled: true });
  });
});
