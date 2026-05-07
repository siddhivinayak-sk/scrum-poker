import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

/**
 * Guard for retro board pages. Redirects to the retro login page
 * if the user doesn't have a valid auth token.
 */
export const retroAuthGuard: CanActivateFn = (route) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  const token = authService.getToken();
  if (token) {
    return true;
  }

  const sessionId = route.paramMap.get('sessionId') ?? '';
  return router.createUrlTree(['/retro', sessionId, 'login']);
};
