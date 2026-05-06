import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class BasePathService {
  /**
   * Returns the base path prefix for API calls and WebSocket URLs.
   * Reads from window.__BASE_PATH__ injected by the server.
   * Returns empty string for root deployment, or '/scrum-poker' etc.
   */
  getBasePath(): string {
    return (window as any).__BASE_PATH__ || '';
  }

  /**
   * Prefix an API path with the base path.
   * e.g., getApiUrl('/api/auth/login') => '/scrum-poker/api/auth/login'
   */
  getApiUrl(path: string): string {
    return this.getBasePath() + path;
  }
}
