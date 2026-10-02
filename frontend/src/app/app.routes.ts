import { Routes } from '@angular/router';
import { DashboardPage } from './pages/dashboard.page';
import { MinerSettingsPage } from './pages/miner-settings.page';
import { AsicPage } from './pages/asic.page';
import { FleetPage } from './pages/fleet.page';

export const routes: Routes = [
  { path: '', component: DashboardPage, title: 'hashes.space' },
  { path: 'asic', component: AsicPage, title: 'Find ASIC · hashes.space' },
  { path: 'fleet', component: FleetPage, title: 'Fleet · hashes.space' },
  { path: 'settings', component: MinerSettingsPage, title: 'Miner settings · hashes.space' },
  { path: 'miners', redirectTo: 'settings' },
  { path: '**', redirectTo: '' },
];
