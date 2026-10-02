import { ChangeDetectionStrategy, Component, OnDestroy, inject, signal } from '@angular/core';
import { FleetSocketService } from '../services/fleet-socket.service';
import { ChainStripComponent } from '../components/chain-strip.component';
import { RouterLink } from '@angular/router';
import { MinerPanelComponent } from '../components/miner-panel.component';
import { ShareStreamComponent } from '../components/share-stream.component';
import { FanComponent } from '../components/fan.component';
import { NetworkBarComponent } from '../components/network-bar.component';
import { HashrateChartComponent } from '../components/hashrate-chart.component';
import { MinerLoginComponent } from '../components/miner-login.component';

/** Hash function picker, the blockchain it streams, then the ONE connected miner in its current mode. */
@Component({
  selector: 'app-dashboard-page',
  standalone: true,
  imports: [NetworkBarComponent, ChainStripComponent, RouterLink, MinerPanelComponent, HashrateChartComponent, MinerLoginComponent, ShareStreamComponent, FanComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dashboard.page.html',
  styleUrl: './dashboard.page.scss',
})
export class DashboardPage implements OnDestroy {
  readonly socket = inject(FleetSocketService);
  readonly now = signal(Date.now());
  private clock = setInterval(() => this.now.set(Date.now()), 1000);

  ngOnDestroy(): void {
    clearInterval(this.clock);
  }
}
