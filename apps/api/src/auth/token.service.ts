import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import type { CookieOptions, Response } from 'express';
import { AppConfig } from '../config/app-config';
import {
  ACCESS_COOKIE,
  type AccessClaims,
  type MfaChallengeClaims,
  REFRESH_COOKIE,
  type RefreshClaims,
} from './auth.types';

const MFA_CHALLENGE_TTL_SECONDS = 300;

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
