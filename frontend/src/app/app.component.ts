import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { DecimalPipe } from '@angular/common';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { FleetSocketService } from './services/fleet-socket.service';
import { FanComponent } from './components/fan.component';

/** Shell: header with navigation, then the active page. */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, FanComponent, DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {
  readonly socket = inject(FleetSocketService);
  readonly sourceLabel = computed(() => this.socket.chain()?.source ?? '…');

  constructor() {
    // opened as asic.<domain>, or nothing connected yet: start at Find ASIC
    const router = inject(Router);
    const onRoot = location.pathname === '/' || location.pathname === '';
    if (onRoot && (location.hostname.startsWith('asic.') || !this.socket.hasRemembered())) router.navigateByUrl('/asic');
  }
}
