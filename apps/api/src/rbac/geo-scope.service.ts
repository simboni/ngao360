import { Injectable } from '@nestjs/common';
import type { TenantTx } from '@ngao360/db';
import { type GeoLocation, pathToUnitIds, STATION_GEO_SELECT, stationGeoLocation } from './scope';

export type GeoResolver = (tx: TenantTx, id: string) => Promise<GeoLocation | null>;

/**
 * Resolves the geography of a record so RbacGuard can check scoped grants.
 * Modules register resolvers for their own record kinds in onModuleInit, e.g.
 *
 *   geo.register('submission', async (tx, id) => { ... return { unitIds, stationId } })
 */
@Injectable()
export class GeoScopeService {
  private readonly resolvers = new Map<string, GeoResolver>();

  constructor() {
    this.register('geographicUnit', async (tx, id) => {
      const unit = await tx.geographicUnit.findUnique({ where: { id }, select: { path: true } });
      return unit ? { unitIds: pathToUnitIds(unit.path), stationId: null } : null;
    });
    this.register('pollingStation', (tx, id) => this.stationLocation(tx, id));
  }

  register(kind: string, resolver: GeoResolver): void {
    this.resolvers.set(kind, resolver);
  }

  has(kind: string): boolean {
    return this.resolvers.has(kind);
  }

  async resolve(tx: TenantTx, kind: string, id: string): Promise<GeoLocation | null> {
    const resolver = this.resolvers.get(kind);
    if (!resolver) throw new Error(`No geo resolver registered for kind "${kind}"`);
    return resolver(tx, id);
  }

  /** Helper for resolvers of records that reference a polling station. */
  async stationLocation(tx: TenantTx, stationId: string): Promise<GeoLocation | null> {
    const s = await tx.pollingStation.findUnique({ where: { id: stationId }, select: STATION_GEO_SELECT });
    return s ? stationGeoLocation(s) : null;
  }
}
