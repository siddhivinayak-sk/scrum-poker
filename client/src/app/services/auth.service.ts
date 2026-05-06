import { Injectable, signal, Signal, OnDestroy, inject, Injector } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, tap, map, catchError, of, throwError } from 'rxjs';
import { User } from '@shared/types';
import { ToastService } from './toast.service';
import { BasePathService } from './base-path.service';
import { WebSocketService } from './websocket.service';
import { SessionStateService } from './session-state.service';

export interface AuthResult {
  token: string;
  user: User;
}

const TOKEN_KEY = 'scrum-poker-token';
const USER_KEY = 'scrum-poker-user';

@Injectable({ providedIn: 'root' })
export class AuthService implements OnDestroy {
  private readonly currentUser = signal<User | null>(null);
  private readonly storageListener: (event: StorageEvent) => void;
  private readonly toastService = inject(ToastService);
  private readonly basePath = inject(BasePathService);
  private readonly wsService = inject(WebSocketService);
  private readonly injector = inject(Injector);

  constructor(private readonly http: HttpClient) {
    // Listen for storage events to detect cross-tab logout
    this.storageListener = (event: StorageEvent) => {
      if (event.key === TOKEN_KEY && event.newValue === null) {
        this.currentUser.set(null);
      }
    };
    window.addEventListener('storage', this.storageListener);

    // On init, check localStorage for existing token and validate
    this.restoreSession();
  }

  ngOnDestroy(): void {
    window.removeEventListener('storage', this.storageListener);
  }

  /**
   * POST /api/auth/login — authenticate user, store token and user in localStorage.
   */
  login(username: string, isAnonymous: boolean): Observable<AuthResult> {
    return this.http
      .post<AuthResult>(this.basePath.getApiUrl('/api/auth/login'), { username, isAnonymous })
      .pipe(
        tap((result) => {
          localStorage.setItem(TOKEN_KEY, result.token);
          localStorage.setItem(USER_KEY, JSON.stringify(result.user));
          this.currentUser.set(result.user);
        }),
        catchError((error) => {
          this.toastService.show('error', 'Authentication failed. Please try again.');
          return throwError(() => error);
        })
      );
  }

  /**
   * GET /api/auth/validate — validate existing session token.
   * Returns the User if valid, null otherwise.
   */
  validateSession(): Observable<User | null> {
    const token = this.getToken();
    if (!token) {
      return of(null);
    }

    const headers = new HttpHeaders({ Authorization: `Bearer ${token}` });
    return this.http.get<{ user: User }>(this.basePath.getApiUrl('/api/auth/validate'), { headers }).pipe(
      map((response) => {
        localStorage.setItem(USER_KEY, JSON.stringify(response.user));
        this.currentUser.set(response.user);
        return response.user;
      }),
      catchError(() => {
        this.toastService.show('error', 'Session validation failed. Please log in again.');
        this.clearStorage();
        return of(null);
      })
    );
  }

  /**
   * POST /api/auth/logout — invalidate session, clear localStorage.
   * Listens for storage events for cross-tab logout.
   */
  logout(): void {
    const token = this.getToken();
    if (token) {
      const headers = new HttpHeaders({ Authorization: `Bearer ${token}` });
      this.http.post(this.basePath.getApiUrl('/api/auth/logout'), {}, { headers }).subscribe();
    }
    this.wsService.disconnect();
    // Use injector to avoid circular dependency (SessionStateService -> AuthService -> SessionStateService)
    const sessionState = this.injector.get(SessionStateService);
    sessionState.reset();
    this.clearStorage();
    this.currentUser.set(null);
  }

  /**
   * Returns the stored session token, or null if not present.
   */
  getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  /**
   * Returns a readonly Signal of the current user.
   */
  getCurrentUser(): Signal<User | null> {
    return this.currentUser.asReadonly();
  }

  /**
   * Store a return-to path in sessionStorage for post-login redirect.
   */
  setReturnTo(path: string): void {
    sessionStorage.setItem('scrum-poker-return-to', path);
  }

  /**
   * Read and clear the stored return-to path from sessionStorage.
   * Returns the path if one was stored, or null otherwise.
   */
  getReturnTo(): string | null {
    const path = sessionStorage.getItem('scrum-poker-return-to');
    if (path) {
      sessionStorage.removeItem('scrum-poker-return-to');
    }
    return path;
  }

  /**
   * On service init, restore session from localStorage and validate the token.
   */
  private restoreSession(): void {
    const token = this.getToken();
    const storedUser = localStorage.getItem(USER_KEY);

    if (token && storedUser) {
      try {
        const user: User = JSON.parse(storedUser);
        this.currentUser.set(user);
      } catch {
        // Invalid stored user data — clear and move on
        this.clearStorage();
      }

      // Validate the token in the background
      this.validateSession().subscribe();
    }
  }

  private clearStorage(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
}
