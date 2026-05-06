import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal, WritableSignal } from '@angular/core';
import { SessionSettingsPanelComponent } from './session-settings-panel.component';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { SessionStateService } from '../../services/session-state.service';
import { BasePathService } from '../../services/base-path.service';
import {
  SessionConfiguration,
  VotingRound,
  User,
} from '@shared/types';

describe('SessionSettingsPanelComponent', () => {
  let fixture: ComponentFixture<SessionSettingsPanelComponent>;
  let component: SessionSettingsPanelComponent;
  let httpTesting: HttpTestingController;
  let toastServiceMock: { show: ReturnType<typeof vi.fn> };
  let authServiceMock: {
    getToken: ReturnType<typeof vi.fn>;
    getCurrentUser: ReturnType<typeof vi.fn>;
    login: ReturnType<typeof vi.fn>;
    validateSession: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
    getReturnTo: ReturnType<typeof vi.fn>;
    setReturnTo: ReturnType<typeof vi.fn>;
  };
  let currentRoundSignal: WritableSignal<VotingRound | null>;
  let sessionStateServiceMock: {
    currentRound: WritableSignal<VotingRound | null>;
  };
  let basePathMock: { getBasePath: ReturnType<typeof vi.fn>; getApiUrl: ReturnType<typeof vi.fn> };

  const defaultConfig: SessionConfiguration = {
    votingSystem: 'fibonacci',
    revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
    issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
    autoReveal: false,
    countdownAnimation: true,
  };

  beforeEach(() => {
    currentRoundSignal = signal<VotingRound | null>(null);

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

    sessionStateServiceMock = {
      currentRound: currentRoundSignal,
    };

    basePathMock = {
      getBasePath: vi.fn().mockReturnValue(''),
      getApiUrl: vi.fn().mockImplementation((path: string) => path),
    };

    TestBed.configureTestingModule({
      imports: [SessionSettingsPanelComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: authServiceMock },
        { provide: ToastService, useValue: toastServiceMock },
        { provide: SessionStateService, useValue: sessionStateServiceMock },
        { provide: BasePathService, useValue: basePathMock },
      ],
    });

    fixture = TestBed.createComponent(SessionSettingsPanelComponent);
    component = fixture.componentInstance;
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpTesting.verify();
  });

  /**
   * Helper to set up the component with standard inputs and open the panel.
   */
  function setupWithConfig(config: SessionConfiguration = defaultConfig, isOwner = true): void {
    fixture.componentRef.setInput('sessionId', 'test-session-123');
    fixture.componentRef.setInput('config', config);
    fixture.componentRef.setInput('isOwner', isOwner);
    fixture.detectChanges();

    if (isOwner) {
      // Open the panel
      component.togglePanel();
      fixture.detectChanges();
    }
  }

  /**
   * Helper to set up the component with panel and advanced settings open.
   */
  function setupWithAdvanced(config: SessionConfiguration = defaultConfig, isOwner = true): void {
    setupWithConfig(config, isOwner);
    if (isOwner) {
      component.toggleAdvanced();
      fixture.detectChanges();
    }
  }

  describe('advanced settings grouping', () => {
    it('should have advanced settings collapsed by default', () => {
      setupWithConfig();
      expect(component.showAdvanced()).toBe(false);
      const advancedSection = fixture.nativeElement.querySelector('#advanced-settings-panel');
      expect(advancedSection).toBeNull();
    });

    it('should show advanced settings when toggle is clicked', () => {
      setupWithConfig();
      component.toggleAdvanced();
      fixture.detectChanges();

      expect(component.showAdvanced()).toBe(true);
      const advancedSection = fixture.nativeElement.querySelector('#advanced-settings-panel');
      expect(advancedSection).toBeTruthy();
    });

    it('should have aria-expanded on advanced toggle button', () => {
      setupWithConfig();
      const advancedToggle = fixture.nativeElement.querySelector('.advanced-toggle');
      expect(advancedToggle?.getAttribute('aria-expanded')).toBe('false');

      component.toggleAdvanced();
      fixture.detectChanges();
      expect(advancedToggle?.getAttribute('aria-expanded')).toBe('true');
    });

    it('should show voting system as primary visible field without expanding advanced', () => {
      setupWithConfig();
      const select = fixture.nativeElement.querySelector('select#settings-votingSystem');
      expect(select).toBeTruthy();
    });

    it('should hide permission fields when advanced is collapsed', () => {
      setupWithConfig();
      const revealRadios = fixture.nativeElement.querySelectorAll(
        'input[type="radio"][formControlName="revealPermission"]'
      );
      expect(revealRadios.length).toBe(0);
    });
  });

  describe('auto-reveal indicator', () => {
    it('should render the gear icon button when auto-reveal is enabled', () => {
      const configWithAutoReveal: SessionConfiguration = {
        ...defaultConfig,
        autoReveal: true,
      };
      fixture.componentRef.setInput('sessionId', 'test-session-123');
      fixture.componentRef.setInput('config', configWithAutoReveal);
      fixture.componentRef.setInput('isOwner', true);
      fixture.detectChanges();

      const toggleBtn = fixture.nativeElement.querySelector('.toggle-btn');
      expect(toggleBtn).toBeTruthy();
    });

    it('should not show auto-reveal badge when auto-reveal is disabled', () => {
      fixture.componentRef.setInput('sessionId', 'test-session-123');
      fixture.componentRef.setInput('config', defaultConfig);
      fixture.componentRef.setInput('isOwner', true);
      fixture.detectChanges();

      const badge = fixture.nativeElement.querySelector('.auto-reveal-badge');
      expect(badge).toBeNull();
    });
  });

  describe('displays current session configuration', () => {
    it('should not render when isOwner is false', () => {
      setupWithConfig(defaultConfig, false);

      const wrapper = fixture.nativeElement.querySelector('.settings-wrapper');
      expect(wrapper).toBeNull();
    });

    it('should render the toggle button when isOwner is true', () => {
      fixture.componentRef.setInput('sessionId', 'test-session-123');
      fixture.componentRef.setInput('config', defaultConfig);
      fixture.componentRef.setInput('isOwner', true);
      fixture.detectChanges();

      const toggleBtn = fixture.nativeElement.querySelector('.toggle-btn');
      expect(toggleBtn).toBeTruthy();
      expect(toggleBtn?.textContent).toContain('⚙');
    });

    it('should show the settings panel when toggled open', () => {
      setupWithConfig();

      const panel = fixture.nativeElement.querySelector('#settings-panel');
      expect(panel).toBeTruthy();
    });

    it('should display the current voting system value', () => {
      setupWithConfig();

      expect(component.settingsForm.get('votingSystem')?.value).toBe('fibonacci');
    });

    it('should display the current reveal permission value', () => {
      setupWithConfig();

      expect(component.settingsForm.get('revealPermission')?.value).toBe('moderator-only');
    });

    it('should display the current issue permission value', () => {
      setupWithConfig();

      expect(component.settingsForm.get('issuePermission')?.value).toBe('moderator-only');
    });

    it('should display the current autoReveal value', () => {
      setupWithConfig();

      expect(component.settingsForm.get('autoReveal')?.value).toBe(false);
    });

    it('should display the current countdownAnimation value', () => {
      setupWithConfig();

      expect(component.settingsForm.get('countdownAnimation')?.value).toBe(true);
    });

    it('should display non-default config values correctly', () => {
      const customConfig: SessionConfiguration = {
        votingSystem: 't-shirt',
        revealPermission: { mode: 'all-players', allowedUserIds: [] },
        issuePermission: { mode: 'select-specific', allowedUserIds: ['user-1'] },
        autoReveal: true,
        countdownAnimation: false,
      };
      setupWithConfig(customConfig);

      expect(component.settingsForm.get('votingSystem')?.value).toBe('t-shirt');
      expect(component.settingsForm.get('revealPermission')?.value).toBe('all-players');
      expect(component.settingsForm.get('issuePermission')?.value).toBe('select-specific');
      expect(component.settingsForm.get('autoReveal')?.value).toBe(true);
      expect(component.settingsForm.get('countdownAnimation')?.value).toBe(false);
    });
  });

  describe('updates on change', () => {
    it('should send PUT request when voting system changes', () => {
      setupWithConfig();

      component.settingsForm.get('votingSystem')?.setValue('t-shirt');
      component.onFieldChange();

      const req = httpTesting.expectOne('/api/sessions/test-session-123/config');
      expect(req.request.method).toBe('PUT');
      expect(req.request.body.config.votingSystem).toBe('t-shirt');
      expect(req.request.headers.get('Authorization')).toBe('Bearer test-token');

      req.flush({ config: { ...defaultConfig, votingSystem: 't-shirt' } });
    });

    it('should send PUT request when reveal permission changes', () => {
      setupWithConfig();

      component.settingsForm.get('revealPermission')?.setValue('all-players');
      component.onFieldChange();

      const req = httpTesting.expectOne('/api/sessions/test-session-123/config');
      expect(req.request.body.config.revealPermission.mode).toBe('all-players');

      req.flush({ config: { ...defaultConfig, revealPermission: { mode: 'all-players', allowedUserIds: [] } } });
    });

    it('should send PUT request when issue permission changes', () => {
      setupWithConfig();

      component.settingsForm.get('issuePermission')?.setValue('all-players');
      component.onFieldChange();

      const req = httpTesting.expectOne('/api/sessions/test-session-123/config');
      expect(req.request.body.config.issuePermission.mode).toBe('all-players');

      req.flush({ config: { ...defaultConfig, issuePermission: { mode: 'all-players', allowedUserIds: [] } } });
    });

    it('should send PUT request when autoReveal changes', () => {
      setupWithConfig();

      component.settingsForm.get('autoReveal')?.setValue(true);
      component.onFieldChange();

      const req = httpTesting.expectOne('/api/sessions/test-session-123/config');
      expect(req.request.body.config.autoReveal).toBe(true);

      req.flush({ config: { ...defaultConfig, autoReveal: true } });
    });

    it('should send PUT request when countdownAnimation changes', () => {
      setupWithConfig();

      component.settingsForm.get('countdownAnimation')?.setValue(false);
      component.onFieldChange();

      const req = httpTesting.expectOne('/api/sessions/test-session-123/config');
      expect(req.request.body.config.countdownAnimation).toBe(false);

      req.flush({ config: { ...defaultConfig, countdownAnimation: false } });
    });

    it('should show error toast when PUT request fails', () => {
      setupWithConfig();

      component.settingsForm.get('autoReveal')?.setValue(true);
      component.onFieldChange();

      const req = httpTesting.expectOne('/api/sessions/test-session-123/config');
      req.flush({ error: 'Server error' }, { status: 500, statusText: 'Internal Server Error' });

      expect(toastServiceMock.show).toHaveBeenCalledWith('error', 'Failed to update session settings.');
    });

    it('should preserve allowedUserIds from original config in permission updates', () => {
      const configWithAllowedUsers: SessionConfiguration = {
        ...defaultConfig,
        revealPermission: { mode: 'select-specific', allowedUserIds: ['user-a', 'user-b'] },
      };
      setupWithConfig(configWithAllowedUsers);

      component.settingsForm.get('autoReveal')?.setValue(true);
      component.onFieldChange();

      const req = httpTesting.expectOne('/api/sessions/test-session-123/config');
      expect(req.request.body.config.revealPermission.allowedUserIds).toEqual(['user-a', 'user-b']);

      req.flush({ config: { ...configWithAllowedUsers, autoReveal: true } });
    });
  });

  describe('warning on voting system change during active round', () => {
    it('should show warning toast when voting system changes during active voting round', () => {
      setupWithConfig();

      // Set an active voting round
      currentRoundSignal.set({
        id: 'round-1',
        storyDescription: 'Test story',
        status: 'voting',
        selections: new Map(),
        startedAt: new Date().toISOString(),
      });

      component.settingsForm.get('votingSystem')?.setValue('t-shirt');
      component.onFieldChange();

      expect(toastServiceMock.show).toHaveBeenCalledWith(
        'warning',
        'Changing the voting system during an active round may invalidate existing votes.'
      );

      // Clean up the HTTP request
      const req = httpTesting.expectOne('/api/sessions/test-session-123/config');
      req.flush({ config: { ...defaultConfig, votingSystem: 't-shirt' } });
    });

    it('should not show warning when voting system changes with no active round', () => {
      setupWithConfig();

      currentRoundSignal.set(null);

      component.settingsForm.get('votingSystem')?.setValue('t-shirt');
      component.onFieldChange();

      expect(toastServiceMock.show).not.toHaveBeenCalledWith(
        'warning',
        expect.any(String)
      );

      const req = httpTesting.expectOne('/api/sessions/test-session-123/config');
      req.flush({ config: { ...defaultConfig, votingSystem: 't-shirt' } });
    });

    it('should not show warning when voting system changes during revealed round', () => {
      setupWithConfig();

      currentRoundSignal.set({
        id: 'round-1',
        storyDescription: 'Test story',
        status: 'revealed',
        selections: new Map(),
        startedAt: new Date().toISOString(),
      });

      component.settingsForm.get('votingSystem')?.setValue('power-of-2');
      component.onFieldChange();

      expect(toastServiceMock.show).not.toHaveBeenCalledWith(
        'warning',
        expect.any(String)
      );

      const req = httpTesting.expectOne('/api/sessions/test-session-123/config');
      req.flush({ config: { ...defaultConfig, votingSystem: 'power-of-2' } });
    });

    it('should not show warning when non-voting-system fields change during active round', () => {
      setupWithConfig();

      currentRoundSignal.set({
        id: 'round-1',
        storyDescription: 'Test story',
        status: 'voting',
        selections: new Map(),
        startedAt: new Date().toISOString(),
      });

      // Change autoReveal, not voting system
      component.settingsForm.get('autoReveal')?.setValue(true);
      component.onFieldChange();

      expect(toastServiceMock.show).not.toHaveBeenCalledWith(
        'warning',
        expect.any(String)
      );

      const req = httpTesting.expectOne('/api/sessions/test-session-123/config');
      req.flush({ config: { ...defaultConfig, autoReveal: true } });
    });
  });

  describe('toggle panel', () => {
    it('should start with panel closed', () => {
      fixture.componentRef.setInput('sessionId', 'test-session-123');
      fixture.componentRef.setInput('config', defaultConfig);
      fixture.componentRef.setInput('isOwner', true);
      fixture.detectChanges();

      expect(component.isOpen()).toBe(false);
      const panel = fixture.nativeElement.querySelector('#settings-panel');
      expect(panel).toBeNull();
    });

    it('should toggle panel open and closed', () => {
      fixture.componentRef.setInput('sessionId', 'test-session-123');
      fixture.componentRef.setInput('config', defaultConfig);
      fixture.componentRef.setInput('isOwner', true);
      fixture.detectChanges();

      component.togglePanel();
      fixture.detectChanges();
      expect(component.isOpen()).toBe(true);
      expect(fixture.nativeElement.querySelector('#settings-panel')).toBeTruthy();

      component.togglePanel();
      fixture.detectChanges();
      expect(component.isOpen()).toBe(false);
      expect(fixture.nativeElement.querySelector('#settings-panel')).toBeNull();
    });

    it('should set aria-expanded on toggle button', () => {
      fixture.componentRef.setInput('sessionId', 'test-session-123');
      fixture.componentRef.setInput('config', defaultConfig);
      fixture.componentRef.setInput('isOwner', true);
      fixture.detectChanges();

      const toggleBtn = fixture.nativeElement.querySelector('.toggle-btn');
      expect(toggleBtn?.getAttribute('aria-expanded')).toBe('false');

      component.togglePanel();
      fixture.detectChanges();
      expect(toggleBtn?.getAttribute('aria-expanded')).toBe('true');
    });
  });

  describe('accessibility', () => {
    it('should have aria-controls on toggle button', () => {
      fixture.componentRef.setInput('sessionId', 'test-session-123');
      fixture.componentRef.setInput('config', defaultConfig);
      fixture.componentRef.setInput('isOwner', true);
      fixture.detectChanges();

      const toggleBtn = fixture.nativeElement.querySelector('.toggle-btn');
      expect(toggleBtn?.getAttribute('aria-controls')).toBe('settings-panel');
    });

    it('should have role="region" on the settings panel', () => {
      setupWithConfig();

      const panel = fixture.nativeElement.querySelector('#settings-panel');
      expect(panel?.getAttribute('role')).toBe('region');
    });

    it('should have aria-label on the settings panel', () => {
      setupWithConfig();

      const panel = fixture.nativeElement.querySelector('#settings-panel');
      expect(panel?.getAttribute('aria-label')).toBe('Session settings');
    });

    it('should have aria-label on the settings form', () => {
      setupWithConfig();

      const form = fixture.nativeElement.querySelector('form');
      expect(form?.getAttribute('aria-label')).toBe('Session settings form');
    });

    it('should have labels for the voting system select', () => {
      setupWithConfig();

      const label = fixture.nativeElement.querySelector('label[for="settings-votingSystem"]');
      expect(label).toBeTruthy();
      expect(label?.textContent).toContain('Voting System');
    });

    it('should have fieldsets with legends for permission groups', () => {
      setupWithAdvanced();

      const fieldsets = fixture.nativeElement.querySelectorAll('fieldset');
      const legends = Array.from(fieldsets).map(
        (fs: any) => fs.querySelector('legend')?.textContent?.trim()
      );
      expect(legends).toContain('Reveal Permission');
      expect(legends).toContain('Issue Permission');
      expect(legends).toContain('Additional Options');
    });

    it('should have role="radiogroup" on permission radio groups', () => {
      setupWithAdvanced();

      const radioGroups = fixture.nativeElement.querySelectorAll('[role="radiogroup"]');
      expect(radioGroups.length).toBe(2);
    });
  });

  describe('form rendering', () => {
    it('should render voting system select with four options', () => {
      setupWithConfig();

      const select = fixture.nativeElement.querySelector('select#settings-votingSystem') as HTMLSelectElement;
      expect(select).toBeTruthy();

      const options = select.querySelectorAll('option');
      expect(options.length).toBe(4);

      const values = Array.from(options).map((o: any) => o.value);
      expect(values).toContain('fibonacci');
      expect(values).toContain('modified-fibonacci');
      expect(values).toContain('t-shirt');
      expect(values).toContain('power-of-2');
    });

    it('should render reveal permission radio group with three options', () => {
      setupWithAdvanced();

      const radios = fixture.nativeElement.querySelectorAll(
        'input[type="radio"][formControlName="revealPermission"]'
      );
      expect(radios.length).toBe(3);
    });

    it('should render issue permission radio group with three options', () => {
      setupWithAdvanced();

      const radios = fixture.nativeElement.querySelectorAll(
        'input[type="radio"][formControlName="issuePermission"]'
      );
      expect(radios.length).toBe(3);
    });

    it('should render autoReveal checkbox', () => {
      setupWithAdvanced();

      const checkbox = fixture.nativeElement.querySelector(
        'input[type="checkbox"][formControlName="autoReveal"]'
      );
      expect(checkbox).toBeTruthy();
    });

    it('should render countdownAnimation checkbox', () => {
      setupWithAdvanced();

      const checkbox = fixture.nativeElement.querySelector(
        'input[type="checkbox"][formControlName="countdownAnimation"]'
      );
      expect(checkbox).toBeTruthy();
    });
  });
});
