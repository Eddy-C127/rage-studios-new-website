import { Component, model, signal, inject, effect, Injector, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Router } from '@angular/router';
import { PackagesService, Package } from '../../../features/landing/services/packages.service';

@Component({
  selector: 'app-packages-modal',
  standalone: true,
  imports: [],
  templateUrl: './packages-modal.html',
  styleUrl: './packages-modal.scss'
})
export class PackagesModal {
  visible = model<boolean>(false);

  private router = inject(Router);
  private packagesService = inject(PackagesService);
  private platformId = inject(PLATFORM_ID);
  private injector = inject(Injector);
  private isBrowser = isPlatformBrowser(this.platformId);

  packages = signal<Package[]>([]);
  isLoading = signal(false);
  selected = signal<Package | null>(null);
  showPolicies = signal(false);
  sheetVisible = signal(false);

  constructor() {
    effect(() => {
      if (this.visible()) {
        this.onOpen();
      } else {
        this.sheetVisible.set(false);
        this.selected.set(null);
        this.showPolicies.set(false);
      }
    }, { injector: this.injector });
  }

  private async onOpen() {
    // Animate in
    requestAnimationFrame(() => setTimeout(() => this.sheetVisible.set(true), 16));

    if (this.packages().length === 0 && this.isBrowser) {
      this.isLoading.set(true);
      try {
        const pkgs = await this.packagesService.getActivePackages();
        this.packages.set(pkgs);
      } finally {
        this.isLoading.set(false);
      }
    }
  }

  close() {
    this.sheetVisible.set(false);
    setTimeout(() => this.visible.set(false), 380);
  }

  onOverlayClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains('pkg-overlay')) {
      this.close();
    }
  }

  selectPackage(pkg: Package) {
    this.selected.set(pkg);
  }

  openPolicies(pkg: Package, e: MouseEvent) {
    e.stopPropagation();
    this.selected.set(pkg);
    this.showPolicies.set(true);
  }

  closePolicies() {
    this.showPolicies.set(false);
  }

  proceed() {
    const pkg = this.selected();
    if (!pkg) return;
    this.close();
    setTimeout(() => this.router.navigate(['/checkout', pkg.id]), 400);
  }

  getClassesText(pkg: Package): string {
    if (pkg.is_unlimited) return '∞  ILIMITADAS';
    return `${pkg.classes_count ?? pkg.credits_count} CLASES`;
  }

  getValidityText(pkg: Package): string {
    return `${pkg.validity_days} DÍAS`;
  }
}
