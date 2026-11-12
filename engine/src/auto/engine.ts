import { adoptLanded } from './adopt.js';
import { launchPasses, settlePasses, type LaunchReport } from './passes.js';
import type { AutoContext, AutoPorts } from './ports.js';
import { sendDue, type SendReport } from './send.js';

export type AutoReport = LaunchReport & SendReport;

/** Adopts first, or settling and relaunching would make this pass's items look like a stranger's. */
export async function autoPoll(ctx: AutoContext, ports: AutoPorts): Promise<AutoReport> {
  adoptLanded(ctx, ports);
  await settlePasses(ctx, ports);
  const launch = await launchPasses(ctx, ports);
  return { ...launch, ...(await sendDue(ctx, ports)) };
}

export async function autoTick(ctx: AutoContext, ports: AutoPorts): Promise<SendReport> {
  adoptLanded(ctx, ports);
  return sendDue(ctx, ports);
}
