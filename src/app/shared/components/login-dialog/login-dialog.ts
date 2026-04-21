import { Component, model, output, inject } from '@angular/core';
import { Router } from '@angular/router';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { PasswordModule } from 'primeng/password';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { SupabaseService } from '../../../core/services/supabase-service';

@Component({
  selector: 'app-login-dialog',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    DialogModule,
    ButtonModule,
    InputTextModule,
    PasswordModule,
    ToastModule
  ],
  providers: [MessageService],
  templateUrl: './login-dialog.html',
  styleUrl: './login-dialog.scss'
})
export class LoginDialog {
  visible = model<boolean>(false);
  openRegister = output<void>();
  openForgotPassword = output<void>();
  
  private fb = inject(FormBuilder);
  private supabaseService = inject(SupabaseService);
  private messageService = inject(MessageService);
  private router = inject(Router);
  
  loginForm: FormGroup;
  isLoading = false;
  
  constructor() {
    this.loginForm = this.fb.group({
      email: ['', [Validators.required, Validators.email]],
      password: ['', [Validators.required, Validators.minLength(6)]]
    });
  }
  
  get email() {
    return this.loginForm.get('email');
  }
  
  get password() {
    return this.loginForm.get('password');
  }
  
  async onLogin() {
    if (this.loginForm.invalid) {
      this.loginForm.markAllAsTouched();
      return;
    }
    
    this.isLoading = true;
    const { email, password } = this.loginForm.value;
    
    try {
      await this.supabaseService.signIn(email, password);

      this.messageService.add({
        severity: 'success',
        summary: 'Éxito',
        detail: 'Sesión iniciada correctamente',
        life: 3000
      });

      setTimeout(() => {
        this.visible.set(false);
        this.loginForm.reset();
        this.router.navigate(['/dashboard']);
      }, 500);
      
    } catch (error: any) {
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: this.getErrorMessage(error),
        life: 5000
      });
    } finally {
      this.isLoading = false;
    }
  }
  
  private getErrorMessage(error: any): string {
    if (error.message === 'Invalid login credentials') {
      return 'Credenciales inválidas';
    }
    if (error.message === 'Email not confirmed') {
      return 'Por favor confirma tu email antes de iniciar sesión';
    }
    return error.message || 'Error al iniciar sesión';
  }
  
  onOpenRegister() {
    this.visible.set(false);
    this.loginForm.reset();
    this.openRegister.emit();
  }
  
  onOpenForgotPassword() {
    this.visible.set(false);
    this.loginForm.reset();
    this.openForgotPassword.emit();
  }
  
  onDialogHide() {
    this.visible.set(false);
    this.loginForm.reset();
  }
}