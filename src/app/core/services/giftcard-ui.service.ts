import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class GiftcardUiService {
  showGiftcardDialog = signal(false);

  openGiftcardDialog() { this.showGiftcardDialog.set(true); }
  closeGiftcardDialog() { this.showGiftcardDialog.set(false); }
}
