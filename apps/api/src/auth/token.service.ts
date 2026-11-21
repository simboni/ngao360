import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, Response } from 'express';
import { AppConfig } from '../config/app-config';
import {
  ACCESS_COOKIE,
  type AccessClaims,
  KNOWN_DEVICE_COOKIE,
  KNOWN_DEVICE_DAYS,
  type MfaChallengeClaims,
  REFRESH_COOKIE,
  type RefreshClaims,
} from './auth.types';

const MFA_CHALLENGE_TTL_SECONDS = 300;
/** Accounts remembered per browser (a shared office device); the oldest mark is dropped first. */
const KNOWN_DEVICE_MAX_MARKS = 8;

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
  ) {}

  signAccess(claims: Omit<AccessClaims, 'typ'>): string {
    return this.jwt.sign(
      { ...claims, typ: 'access' },
      { secret: this.config.values.JWT_ACCESS_SECRET, expiresIn: this.config.values.JWT_ACCESS_TTL_SECONDS },
    );
  }

  verifyAccess(token: string): AccessClaims {
    const claims = this.jwt.verify<AccessClaims>(token, { secret: this.config.values.JWT_ACCESS_SECRET });
    if (claims.typ !== 'access') throw new Error('Wrong token type');
    return claims;
  }

  /** Returns the token and the secret whose SHA-256 is stored on the session. */
  signRefresh(claims: Omit<RefreshClaims, 'typ' | 'sec'>): { token: string; secret: string } {
    const secret = randomBytes(32).toString('base64url');
    const token = this.jwt.sign(
      { ...claims, sec: secret, typ: 'refresh' },
      { secret: this.config.values.JWT_REFRESH_SECRET, expiresIn: this.config.values.JWT_REFRESH_TTL_SECONDS },
    );
    return { token, secret };
  }

  verifyRefresh(token: string): RefreshClaims {
    const claims = this.jwt.verify<RefreshClaims>(token, { secret: this.config.values.JWT_REFRESH_SECRET });
    if (claims.typ !== 'refresh') throw new Error('Wrong token type');
    return claims;
  }

  signMfaChallenge(claims: Omit<MfaChallengeClaims, 'typ'>): string {
    return this.jwt.sign(
      { ...claims, typ: 'mfa_challenge' },
      { secret: this.config.values.JWT_ACCESS_SECRET, expiresIn: MFA_CHALLENGE_TTL_SECONDS },
    );
  }

  verifyMfaChallenge(token: string): MfaChallengeClaims {
    const claims = this.jwt.verify<MfaChallengeClaims>(token, { secret: this.config.values.JWT_ACCESS_SECRET });
    if (claims.typ !== 'mfa_challenge') throw new Error('Wrong token type');
    return claims;
  }

  /* ----------------------------- Known device ----------------------------- */

  private knownDeviceMac(tenantId: string, userId: string, exp: number): string {
    // Own key derived from the refresh secret (domain-separated), so a mark is useless as any token.
    const key = createHmac('sha256', this.config.values.JWT_REFRESH_SECRET).update('ngao360 known-device v1').digest();
    return createHmac('sha256', key).update(`${tenantId}|${userId}|${exp}`).digest('base64url');
  }

  private knownDeviceMarks(cookieValue: string | undefined): Array<{ exp: number; mac: string }> {
    if (!cookieValue || cookieValue.length > 1024) return [];
    const now = Math.floor(Date.now() / 1000);
    return cookieValue
      .split('~')
      .map((m) => {
        const [e, mac] = m.split('.');
        return { exp: Number(e), mac: mac ?? '' };
      })
      .filter((m) => Number.isInteger(m.exp) && m.exp > now && /^[A-Za-z0-9_-]{43}$/.test(m.mac));
  }

  /**
   * True when this browser carries a valid, unexpired mark for the account (set at a completed
   * sign-in). The client address plays no part.
   */
  isKnownDevice(cookieValue: string | undefined, tenantId: string, userId: string): boolean {
    let known = false;
    for (const m of this.knownDeviceMarks(cookieValue)) {
      const expected = Buffer.from(this.knownDeviceMac(tenantId, userId, m.exp));
      const got = Buffer.from(m.mac);
      if (got.length === expected.length && timingSafeEqual(got, expected)) known = true;
    }
    return known;
  }

  /** Remember this browser for the account that just completed a sign-in (the access token's subject). */
  markKnownDevice(res: Response, cookieValue: string | undefined, access: string): void {
    const { sub, tid } = this.verifyAccess(access);
    const exp = Math.floor(Date.now() / 1000) + KNOWN_DEVICE_DAYS * 86_400;
    // Drop this account's older mark (and expired ones), keep the most recent others.
    const others = this.knownDeviceMarks(cookieValue).filter((m) => !this.isKnownDevice(`${m.exp}.${m.mac}`, tid, sub));
    const marks = [...others, { exp, mac: this.knownDeviceMac(tid, sub, exp) }].slice(-KNOWN_DEVICE_MAX_MARKS);
    res.cookie(KNOWN_DEVICE_COOKIE, marks.map((m) => `${m.exp}.${m.mac}`).join('~'), {
      ...this.cookieBase(),
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: KNOWN_DEVICE_DAYS * 86_400_000,
    });
  }

  private cookieBase(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.values.COOKIE_SECURE,
      sameSite: 'lax',
      ...(this.config.values.COOKIE_DOMAIN ? { domain: this.config.values.COOKIE_DOMAIN } : {}),
    };
  }

  setAuthCookies(res: Response, access: string, refresh: string): void {
    res.cookie(ACCESS_COOKIE, access, {
      ...this.cookieBase(),
      path: '/',
      maxAge: this.config.values.JWT_ACCESS_TTL_SECONDS * 1000,
    });
    res.cookie(REFRESH_COOKIE, refresh, {
      ...this.cookieBase(),
      path: '/api/auth',
      maxAge: this.config.values.JWT_REFRESH_TTL_SECONDS * 1000,
    });
  }

  setAccessCookie(res: Response, access: string): void {
    res.cookie(ACCESS_COOKIE, access, {
      ...this.cookieBase(),
      path: '/',
      maxAge: this.config.values.JWT_ACCESS_TTL_SECONDS * 1000,
    });
  }

  clearAuthCookies(res: Response): void {
    res.clearCookie(ACCESS_COOKIE, { ...this.cookieBase(), path: '/' });
    res.clearCookie(REFRESH_COOKIE, { ...this.cookieBase(), path: '/api/auth' });
  }
}
