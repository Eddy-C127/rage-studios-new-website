import { Component, model, output, inject } from '@angular/core';
import { Router } from '@angular/router';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators, AbstractControl, ValidationErrors } from '@angular/forms';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { PasswordModule } from 'primeng/password';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { SupabaseService } from '../../../core/services/supabase-service';

@Component({
  selector: 'app-register-dialog',
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
  templateUrl: './register-dialog.html',
  styleUrl: './register-dialog.scss'
})
export class RegisterDialog {
  visible = model<boolean>(false);
  openLogin = output<void>();
  
  private fb = inject(FormBuilder);
  private supabaseService = inject(SupabaseService);
  private messageService = inject(MessageService);
  private router = inject(Router);
  
  registerForm: FormGroup;
  isLoading = false;
  
  constructor() {
    this.registerForm = this.fb.group({
      fullName: ['', [Validators.required, Validators.minLength(3)]],
      email: ['', [Validators.required, Validators.email]],
      phone: ['', [Validators.required, Validators.pattern(/^[\d\s\-\+\(\)]+$/)]],
      password: ['', [Validators.required, Validators.minLength(6)]],
      confirmPassword: ['', [Validators.required]]
    }, {
      validators: this.passwordMatchValidator
    });
  }
  
  passwordMatchValidator(control: AbstractControl): ValidationErrors | null {
    const password = control.get('password');
    const confirmPassword = control.get('confirmPassword');
    
    if (!password || !confirmPassword) {
      return null;
    }
    
    if (password.value !== confirmPassword.value) {
      confirmPassword.setErrors({ passwordMismatch: true });
      return { passwordMismatch: true };
    } else {
      confirmPassword.setErrors(null);
      return null;
    }
  }
  
  get fullName() {
    return this.registerForm.get('fullName');
  }
  
  get email() {
    return this.registerForm.get('email');
  }
  
  get phone() {
    return this.registerForm.get('phone');
  }
  
  get password() {
    return this.registerForm.get('password');
  }
  
  get confirmPassword() {
    return this.registerForm.get('confirmPassword');
  }
  
  async onRegister() {
    if (this.registerForm.invalid) {
      this.registerForm.markAllAsTouched();
      return;
    }
    
    this.isLoading = true;
    const { email, password, fullName, phone } = this.registerForm.value;
    
    try {
      await this.supabaseService.signUp(email, password, fullName, phone);
      
      this.messageService.add({
        severity: 'success',
        summary: '¡Cuenta creada exitosamente!',
        detail: 'Listo hemos iniciado sesión por ti',
        life: 5000
      });
      
      setTimeout(() => {
        this.visible.set(false);
        this.registerForm.reset();
        this.router.navigate(['/dashboard']);
      }, 1500);
      
    } catch (error: any) {
      this.messageService.add({
        severity: 'error',
        summary: 'Error al crear cuenta',
        detail: this.getErrorMessage(error),
        life: 5000
      });
    } finally {
      this.isLoading = false;
    }
  }
  
  private getErrorMessage(error: any): string {
    if (error.message === 'User already registered') {
      return 'Este correo ya está registrado';
    }
    if (error.message === 'Password should be at least 6 characters') {
      return 'La contraseña debe tener al menos 6 caracteres';
    }
    if (error.message === 'Unable to validate email address: invalid format') {
      return 'Formato de correo inválido';
    }
    return error.message || 'Error al crear la cuenta';
  }
  
  onOpenLogin() {
    this.visible.set(false);
    this.registerForm.reset();
    this.openLogin.emit();
  }
  
  onDialogHide() {
    this.visible.set(false);
    this.registerForm.reset();
  }
}