import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class BookingUiService {
  // Public signal for controlling booking dialog visibility
  showBookingDialog = signal(false);

  // Observable para notificar cuando una reserva se completa exitosamente
  private bookingSuccessSubject = new Subject<void>();
  bookingSuccess$ = this.bookingSuccessSubject.asObservable();

  openBookingDialog() {
    this.showBookingDialog.set(true);
  }

  closeBookingDialog() {
    this.showBookingDialog.set(false);
  }

  notifyBookingSuccess() {
    this.bookingSuccessSubject.next();
  }
}