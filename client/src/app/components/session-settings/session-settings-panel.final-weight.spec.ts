import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { SessionSettingsPanelComponent } from './session-settings-panel.component';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { SessionStateService } from '../../services/session-state.service';
import { BasePathService } from '../../services/base-path.service';
import { SessionConfiguration, VotingRound } from '@shared/types';

/** Validates: Requirements 1 (final weight toggle in the settings panel) */
describe('SessionSettingsPanelComponent - final weight toggle', () => {
  const PUT_URL = '/api/sessions/test-session-123/config';
  let fixture: ComponentFixture<SessionSettingsPanelComponent>;
  let component: SessionSettingsPanelComponent;
  let httpTesting: HttpTestingController;

  const baseConfig: SessionConfiguration = {
    votingSystem: 'fibonacci',
    revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
    issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
    autoReveal: false,
    countdownAnimation: true,
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [SessionSettingsPanelComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { getToken: vi.fn().mockReturnValue('test-token') } },
        { provide: ToastService, useValue: { show: vi.fn() } },
        {
          provide: SessionStateService,
          useValue: { currentRound: signal<VotingRound | null>(null) },
        },
        {
          provide: BasePathService,
          useValue: {
            getBasePath: vi.fn().mockReturnValue(''),
            getApiUrl: vi.fn().mockImplementation((p: string) => p),
          },
        },
      ],
    });
    fixture = TestBed.createComponent(SessionSettingsPanelComponent);
    component = fixture.componentInstance;
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpTesting.verify();
  });

  function setup(config: SessionConfiguration, isGameOwner: boolean): void {
    fixture.componentRef.setInput('sessionId', 'test-session-123');
    fixture.componentRef.setInput('config', config);
    fixture.componentRef.setInput('isOwner', true);
    fixture.componentRef.setInput('isGameOwner', isGameOwner);
    fixture.detectChanges();
    component.togglePanel();
    fixture.detectChanges();
    component.toggleAdvanced();
    fixture.detectChanges();
  }

  function getToggle(): HTMLInputElement | null {
    return fixture.nativeElement.querySelector('#settings-finalWeightEnabled');
  }

  it('renders the toggle unchecked when config omits finalWeightEnabled', () => {
    setup(baseConfig, true);
    expect(getToggle()).toBeTruthy();
    expect(getToggle()?.checked).toBe(false);
  });

  it('reflects finalWeightEnabled true from config', () => {
    setup({ ...baseConfig, finalWeightEnabled: true }, true);
    expect(getToggle()?.checked).toBe(true);
    expect(component.settingsForm.get('finalWeightEnabled')?.value).toBe(true);
  });

  it('reflects finalWeightEnabled false from config', () => {
    setup({ ...baseConfig, finalWeightEnabled: false }, true);
    expect(getToggle()?.checked).toBe(false);
  });

  it('updates the checkbox when the config input changes', () => {
    setup({ ...baseConfig, finalWeightEnabled: false }, true);
    fixture.componentRef.setInput('config', { ...baseConfig, finalWeightEnabled: true });
    fixture.detectChanges();
    expect(component.settingsForm.get('finalWeightEnabled')?.value).toBe(true);
  });

  it('sends finalWeightEnabled true via PUT when the user checks it', () => {
    setup(baseConfig, true);
    getToggle()?.click();
    fixture.detectChanges();

    const req = httpTesting.expectOne(PUT_URL);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body.config.finalWeightEnabled).toBe(true);
    req.flush({ config: { ...baseConfig, finalWeightEnabled: true } });
  });

  it('sends finalWeightEnabled false via PUT when the user unchecks it', () => {
    setup({ ...baseConfig, finalWeightEnabled: true }, true);
    getToggle()?.click();
    fixture.detectChanges();

    const req = httpTesting.expectOne(PUT_URL);
    expect(req.request.body.config.finalWeightEnabled).toBe(false);
    req.flush({ config: { ...baseConfig, finalWeightEnabled: false } });
  });

  it('is available to a moderator who is not the owner and still sends the boolean', () => {
    setup(baseConfig, false);
    const toggle = getToggle();
    expect(toggle).toBeTruthy();

    toggle?.click();
    fixture.detectChanges();

    const req = httpTesting.expectOne(PUT_URL);
    expect(req.request.body.config.finalWeightEnabled).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(req.request.body.config, 'funCallouts')).toBe(false);
    req.flush({ config: { ...baseConfig, finalWeightEnabled: true } });
  });

  it('includes finalWeightEnabled in the payload when another field changes', () => {
    setup({ ...baseConfig, finalWeightEnabled: true }, true);
    component.settingsForm.get('autoReveal')?.setValue(true);
    component.onFieldChange();

    const req = httpTesting.expectOne(PUT_URL);
    expect(req.request.body.config.finalWeightEnabled).toBe(true);
    expect(req.request.body.config.autoReveal).toBe(true);
    req.flush({ config: { ...baseConfig, autoReveal: true, finalWeightEnabled: true } });
  });

  it('keeps autoReveal, countdownAnimation and funCallouts payload keys unchanged', () => {
    setup({ ...baseConfig, funCallouts: true }, true);
    component.settingsForm.get('autoReveal')?.setValue(true);
    component.settingsForm.get('countdownAnimation')?.setValue(false);
    component.settingsForm.get('funCallouts')?.setValue(false);
    component.onFieldChange();

    const req = httpTesting.expectOne(PUT_URL);
    expect(req.request.body.config).toEqual({
      votingSystem: 'fibonacci',
      revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
      issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
      autoReveal: true,
      countdownAnimation: false,
      finalWeightEnabled: false,
      funCallouts: false,
    });
    req.flush({ config: baseConfig });
  });

  it('toggling final weight leaves the other controls untouched', () => {
    setup({ ...baseConfig, autoReveal: true, funCallouts: false }, true);
    const before = { ...component.settingsForm.value };
    getToggle()?.click();
    fixture.detectChanges();

    expect(component.settingsForm.value).toEqual({ ...before, finalWeightEnabled: true });
    httpTesting.expectOne(PUT_URL).flush({ config: baseConfig });
  });
});
