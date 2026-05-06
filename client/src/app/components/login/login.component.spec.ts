import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { LoginComponent } from './login.component';
import { AuthService, AuthResult } from '../../services/auth.service';
import { signal } from '@angular/core';
import { User } from '@shared/types';

describe('LoginComponent', () => {
  let component: LoginComponent;
  let fixture: ComponentFixture<LoginComponent>;
  let authServiceMock: {
    login: ReturnType<typeof vi.fn>;
    getCurrentUser: ReturnType<typeof vi.fn>;
    getToken: ReturnType<typeof vi.fn>;
    validateSession: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
    getReturnTo: ReturnType<typeof vi.fn>;
    setReturnTo: ReturnType<typeof vi.fn>;
  };
  let router: Router;

  const mockUser: User = {
    id: 'test-id',
    displayName: 'TestUser',
    role: 'participant',
    isAnonymous: false,
  };

  const mockAuthResult: AuthResult = {
    token: 'test-token',
    user: mockUser,
  };

  function createAuthServiceMock(currentUser: User | null = null) {
    return {
      login: vi.fn().mockReturnValue(of(mockAuthResult)),
      getCurrentUser: vi.fn().mockReturnValue(signal(currentUser)),
      getToken: vi.fn().mockReturnValue(null),
      validateSession: vi.fn().mockReturnValue(of(null)),
      logout: vi.fn(),
      getReturnTo: vi.fn().mockReturnValue(null),
      setReturnTo: vi.fn(),
    };
  }

  function setupTestBed(currentUser: User | null = null) {
    authServiceMock = createAuthServiceMock(currentUser);

    TestBed.configureTestingModule({
      imports: [LoginComponent],
      providers: [
        provideRouter([
          { path: 'login', component: LoginComponent },
          { path: 'lobby', component: LoginComponent },
          { path: 'poker', component: LoginComponent },
          { path: 'create-session', component: LoginComponent },
        ]),
        provideHttpClient(),
        { provide: AuthService, useValue: authServiceMock },
      ],
    });

    fixture = TestBed.createComponent(LoginComponent);
    component = fixture.componentInstance;
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
    fixture.detectChanges();
  }

  describe('rendering', () => {
    beforeEach(() => setupTestBed());

    it('should create the component', () => {
      expect(component).toBeTruthy();
    });

    it('should display the login form with username input and submit button', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      expect(compiled.querySelector('input[formControlName="username"]')).toBeTruthy();
      expect(compiled.querySelector('button[type="submit"]')).toBeTruthy();
    });

    it('should display mode toggle buttons for Login and Anonymous', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const toggleButtons = compiled.querySelectorAll('.mode-toggle button');
      expect(toggleButtons.length).toBe(2);
      expect(toggleButtons[0].textContent?.trim()).toContain('Login');
      expect(toggleButtons[1].textContent?.trim()).toContain('Anonymous');
    });

    it('should have ARIA labels on form inputs and buttons', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const input = compiled.querySelector('input');
      expect(input?.getAttribute('aria-label')).toBeTruthy();

      const submitBtn = compiled.querySelector('button[type="submit"]');
      expect(submitBtn?.getAttribute('aria-label')).toBeTruthy();

      const toggleButtons = compiled.querySelectorAll('.mode-toggle button');
      toggleButtons.forEach((btn) => {
        expect(btn.getAttribute('aria-label')).toBeTruthy();
      });
    });

    it('should start in login mode (not anonymous)', () => {
      expect(component.isAnonymousMode).toBe(false);
      const compiled = fixture.nativeElement as HTMLElement;
      const loginToggle = compiled.querySelector('.mode-toggle button:first-child');
      expect(loginToggle?.classList.contains('active')).toBe(true);
    });
  });

  describe('mode toggle', () => {
    beforeEach(() => setupTestBed());

    it('should switch to anonymous mode when anonymous button is clicked', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const anonButton = compiled.querySelector('.mode-toggle button:last-child') as HTMLButtonElement;
      anonButton.click();
      fixture.detectChanges();

      expect(component.isAnonymousMode).toBe(true);
      const input = compiled.querySelector('input');
      expect(input?.getAttribute('aria-label')).toContain('display name');
    });

    it('should switch back to login mode when login button is clicked', () => {
      // First switch to anonymous mode via the button
      const compiled = fixture.nativeElement as HTMLElement;
      const anonButton = compiled.querySelector('.mode-toggle button:last-child') as HTMLButtonElement;
      anonButton.click();
      fixture.detectChanges();
      expect(component.isAnonymousMode).toBe(true);

      // Now switch back
      const loginButton = compiled.querySelector('.mode-toggle button:first-child') as HTMLButtonElement;
      loginButton.click();
      fixture.detectChanges();

      expect(component.isAnonymousMode).toBe(false);
    });

    it('should reset form and clear errors when toggling mode', () => {
      // Set up some state first
      component.loginError = 'Some error';
      component.loginForm.get('username')?.setValue('test');
      component.loginForm.markAllAsTouched();

      // Toggle via the button
      const compiled = fixture.nativeElement as HTMLElement;
      const anonButton = compiled.querySelector('.mode-toggle button:last-child') as HTMLButtonElement;
      anonButton.click();
      fixture.detectChanges();

      expect(component.loginError).toBeNull();
      expect(component.loginForm.get('username')?.value).toBeFalsy();
      expect(component.loginForm.get('username')?.touched).toBe(false);
    });
  });

  describe('validation', () => {
    beforeEach(() => setupTestBed());

    it('should show validation error when submitting empty username', () => {
      component.onSubmit();
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const errorMsg = compiled.querySelector('.error-message');
      expect(errorMsg).toBeTruthy();
      expect(errorMsg?.textContent).toContain('username is required');
    });

    it('should show validation error when submitting empty display name in anonymous mode', () => {
      // Switch to anonymous mode via the toggle button
      const compiled = fixture.nativeElement as HTMLElement;
      const anonButton = compiled.querySelector('.mode-toggle button:last-child') as HTMLButtonElement;
      anonButton.click();
      fixture.detectChanges();

      component.onSubmit();
      fixture.detectChanges();

      const errorMsg = compiled.querySelector('.error-message');
      expect(errorMsg).toBeTruthy();
      expect(errorMsg?.textContent).toContain('display name is required');
    });

    it('should not call AuthService.login when form is invalid', () => {
      component.onSubmit();
      expect(authServiceMock.login).not.toHaveBeenCalled();
    });
  });

  describe('successful login', () => {
    beforeEach(() => setupTestBed());

    it('should call AuthService.login with username and isAnonymous=false for regular login', () => {
      component.loginForm.get('username')?.setValue('TestUser');
      component.onSubmit();

      expect(authServiceMock.login).toHaveBeenCalledWith('TestUser', false);
    });

    it('should call AuthService.login with display name and isAnonymous=true for anonymous login', () => {
      // Switch to anonymous mode via the toggle button
      const compiled = fixture.nativeElement as HTMLElement;
      const anonButton = compiled.querySelector('.mode-toggle button:last-child') as HTMLButtonElement;
      anonButton.click();
      fixture.detectChanges();

      component.loginForm.get('username')?.setValue('GuestUser');
      component.onSubmit();

      expect(authServiceMock.login).toHaveBeenCalledWith('GuestUser', true);
    });

    it('should navigate to /lobby on successful login when no returnTo', () => {
      component.loginForm.get('username')?.setValue('TestUser');
      component.onSubmit();

      expect(router.navigate).toHaveBeenCalledWith(['/lobby']);
    });
  });

  describe('returnTo redirect after login', () => {
    beforeEach(() => setupTestBed());

    it('should redirect to returnTo path after successful login', () => {
      authServiceMock.getReturnTo.mockReturnValue('/session/abc12345');

      component.loginForm.get('username')?.setValue('TestUser');
      component.onSubmit();

      expect(authServiceMock.getReturnTo).toHaveBeenCalled();
      expect(router.navigate).toHaveBeenCalledWith(['/session/abc12345']);
    });

    it('should redirect to /lobby when no returnTo is stored', () => {
      authServiceMock.getReturnTo.mockReturnValue(null);

      component.loginForm.get('username')?.setValue('TestUser');
      component.onSubmit();

      expect(authServiceMock.getReturnTo).toHaveBeenCalled();
      expect(router.navigate).toHaveBeenCalledWith(['/lobby']);
    });

    it('should call AuthService.getReturnTo() after login', () => {
      component.loginForm.get('username')?.setValue('TestUser');
      component.onSubmit();

      expect(authServiceMock.getReturnTo).toHaveBeenCalled();
    });
  });

  describe('login error', () => {
    beforeEach(() => setupTestBed());

    it('should display error message on login failure', () => {
      authServiceMock.login.mockReturnValue(
        throwError(() => ({ error: { error: 'UNKNOWN' } }))
      );

      component.loginForm.get('username')?.setValue('TestUser');
      component.onSubmit();
      fixture.detectChanges();

      expect(component.loginError).toBeTruthy();
      const compiled = fixture.nativeElement as HTMLElement;
      const errorMsg = compiled.querySelector('.server-error');
      expect(errorMsg).toBeTruthy();
    });

    it('should show specific error for USERNAME_REQUIRED from server', () => {
      authServiceMock.login.mockReturnValue(
        throwError(() => ({ error: { error: 'USERNAME_REQUIRED' } }))
      );

      component.loginForm.get('username')?.setValue('TestUser');
      component.onSubmit();
      fixture.detectChanges();

      expect(component.loginError).toContain('username is required');
    });

    it('should re-enable submit button after error', () => {
      authServiceMock.login.mockReturnValue(
        throwError(() => ({ error: { error: 'UNKNOWN' } }))
      );

      component.loginForm.get('username')?.setValue('TestUser');
      component.onSubmit();
      fixture.detectChanges();

      expect(component.isSubmitting).toBe(false);
    });
  });

  describe('session redirect', () => {
    it('should redirect to /lobby if user is already logged in and no returnTo', () => {
      setupTestBed(mockUser);
      expect(router.navigate).toHaveBeenCalledWith(['/lobby']);
    });

    it('should redirect to returnTo path if user is already logged in with returnTo stored', () => {
      authServiceMock = createAuthServiceMock(mockUser);
      authServiceMock.getReturnTo.mockReturnValue('/session/xyz78901');

      TestBed.configureTestingModule({
        imports: [LoginComponent],
        providers: [
          provideRouter([
            { path: 'login', component: LoginComponent },
            { path: 'lobby', component: LoginComponent },
            { path: 'poker', component: LoginComponent },
            { path: 'create-session', component: LoginComponent },
          ]),
          provideHttpClient(),
          { provide: AuthService, useValue: authServiceMock },
        ],
      });

      fixture = TestBed.createComponent(LoginComponent);
      component = fixture.componentInstance;
      router = TestBed.inject(Router);
      vi.spyOn(router, 'navigate').mockResolvedValue(true);
      fixture.detectChanges();

      expect(router.navigate).toHaveBeenCalledWith(['/session/xyz78901']);
    });
  });
});
