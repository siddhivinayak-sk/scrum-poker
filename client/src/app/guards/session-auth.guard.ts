import { inject } from '@angular/core';
import { ActivatedRouteSnapshot, CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

export const sessionAuthGuard: CanActivateFn = (route: ActivatedRouteSnapshot) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  const currentUser = authService.getCurrentUser();
  if (currentUser()) {
    return true;
  }

  const sessionId = route.paramMap.get('sessionId');
  if (sessionId) {
    authService.setReturnTo(`/session/${sessionId}`);
  }

  return router.createUrlTree(['/login']);
};
