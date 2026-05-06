import { Component, input } from '@angular/core';
import { QRCodeComponent } from 'angularx-qrcode';

@Component({
  selector: 'app-qr-code',
  standalone: true,
  imports: [QRCodeComponent],
  template: `
    <div class="qr-container">
      <qrcode
        [qrdata]="url()"
        [width]="150"
        [errorCorrectionLevel]="'M'"
        [alt]="'QR code for session link: ' + url()"
        [title]="'QR code for session link: ' + url()"
      ></qrcode>
    </div>
  `,
  styles: [
    `
      .qr-container {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0.75rem;
        border-radius: 12px;
        background: #fff;
        box-shadow: var(--shadow-md);
        min-width: 150px;
        min-height: 150px;
      }
    `,
  ],
})
export class QrCodeDisplayComponent {
  readonly url = input.required<string>();
}
