import { Routes } from '@angular/router';
import { LoginComponent } from './components/login/login.component';
import { authGuard } from './guards/auth.guard';
import { sessionAuthGuard } from './guards/session-auth.guard';
import { retroAuthGuard } from './guards/retro-auth.guard';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  {
    path: 'lobby',
    loadComponent: () =>
      import('./components/lobby/lobby.component').then(
        (m) => m.LobbyComponent
      ),
    canActivate: [authGuard],
  },
  {
    path: 'create-session',
    loadComponent: () =>
      import('./components/session-create/session-create-page.component').then(
        (m) => m.SessionCreatePageComponent
      ),
    canActivate: [authGuard],
  },
  {
    path: 'session/:sessionId',
    loadComponent: () =>
      import('./components/session-poker-page/session-poker-page.component').then(
        (m) => m.SessionPokerPageComponent
      ),
    canActivate: [sessionAuthGuard],
  },
  {
    path: 'retro/create',
    loadComponent: () =>
      import('./components/retro-create/retro-create-page.component').then(
        (m) => m.RetroCreatePageComponent
      ),
    canActivate: [authGuard],
  },
  {
    path: 'retro/:sessionId/login',
    loadComponent: () =>
      import('./components/retro-login/retro-login.component').then(
        (m) => m.RetroLoginComponent
      ),
  },
  {
    path: 'retro/:sessionId',
    loadComponent: () =>
      import('./components/retro-board/retro-board-page.component').then(
        (m) => m.RetroBoardPageComponent
      ),
    canActivate: [retroAuthGuard],
  },
  {
    path: 'poker',
    redirectTo: 'lobby',
    pathMatch: 'full',
  },
  { path: '', redirectTo: 'login', pathMatch: 'full' },
  { path: '**', redirectTo: 'login' },
];
