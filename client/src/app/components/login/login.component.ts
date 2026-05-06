import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
})
export class LoginComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly authService = inject(AuthService);

  loginForm!: FormGroup;
  isAnonymousMode = false;
  isSubmitting = false;
  loginError: string | null = null;

  ngOnInit(): void {
    // If user already has a session, redirect appropriately
    const currentUser = this.authService.getCurrentUser();
    if (currentUser()) {
      const returnTo = this.authService.getReturnTo();
      if (returnTo) {
        this.router.navigate([returnTo]);
      } else {
        this.router.navigate(['/lobby']);
      }
      return;
    }

    this.loginForm = this.fb.group({
      username: ['', [Validators.required, Validators.minLength(1)]],
    });
  }

  toggleMode(): void {
    this.isAnonymousMode = !this.isAnonymousMode;
    this.loginError = null;
    this.loginForm.reset();
    this.loginForm.markAsUntouched();
  }

  get usernameControl() {
    return this.loginForm.get('username');
  }

  onSubmit(): void {
    if (this.loginForm.invalid) {
      this.loginForm.markAllAsTouched();
      return;
    }

    this.isSubmitting = true;
    this.loginError = null;

    const username = this.loginForm.value.username.trim();
    if (!username) {
      this.loginForm.markAllAsTouched();
      this.isSubmitting = false;
      return;
    }

    this.authService.login(username, this.isAnonymousMode).subscribe({
      next: () => {
        const returnTo = this.authService.getReturnTo();
        if (returnTo) {
          this.router.navigate([returnTo]);
        } else {
          this.router.navigate(['/lobby']);
        }
      },
      error: (err) => {
        this.isSubmitting = false;
        this.loginError =
          err?.error?.error === 'USERNAME_REQUIRED' || err?.error?.error === 'DISPLAY_NAME_REQUIRED'
            ? this.isAnonymousMode
              ? 'A display name is required.'
              : 'A username is required.'
            : 'Login failed. Please try again.';
      },
    });
  }
}
