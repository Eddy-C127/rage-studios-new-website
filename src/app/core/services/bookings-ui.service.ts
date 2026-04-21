import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class BookingsUiService {
  showBookingsDialog = signal(false);

  openBookingsDialog() { this.showBookingsDialog.set(true); }
  closeBookingsDialog() { this.showBookingsDialog.set(false); }
}
