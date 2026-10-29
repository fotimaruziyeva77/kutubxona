// ============================================================================
// Privacy Service — PERF-06
// ============================================================================
// Handles the "hide reading history" privacy toggle and filters reading
// history from public-facing responses when the user opts out.
// ============================================================================

import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../infra/prisma/prisma.service";

export interface PrivacySettings {
  hideReadingHistory: boolean;
}

@Injectable()
export class PrivacyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Toggle reading history visibility for a user.
   * PATCH /users/me/privacy { hideReadingHistory: true/false }
   */
  async toggleReadingHistoryVisibility(
    userId: string,
    hide: boolean,
  ): Promise<PrivacySettings> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { hideReadingHistory: hide },
      select: { id: true, hideReadingHistory: true },
    });

    return { hideReadingHistory: updated.hideReadingHistory };
  }

  /**
   * Get current privacy settings for a user.
   * GET /users/me/privacy
   */
  async getPrivacySettings(userId: string): Promise<PrivacySettings> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { hideReadingHistory: true },
    });
    if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");

    return { hideReadingHistory: user.hideReadingHistory };
  }

  /**
   * Filter reading history from public-facing data when the user has
   * hideReadingHistory enabled. Strips bookTransactions and readingIndex
   * arrays from the data object.
   *
   * Used by public profile endpoints to enforce server-side privacy.
   */
  filterReadingHistoryForPublic(
    hideReadingHistory: boolean,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!hideReadingHistory) {
      return data;
    }

    const filtered = { ...data };
    delete filtered.bookTransactions;
    delete filtered.transactions;
    delete filtered.readingIndex;
    return filtered;
  }
}
