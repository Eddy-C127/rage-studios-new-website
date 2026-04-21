import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class PackagesUiService {
  showPackagesModal = signal(false);

  openPackagesModal() { this.showPackagesModal.set(true); }
  closePackagesModal() { this.showPackagesModal.set(false); }
}
