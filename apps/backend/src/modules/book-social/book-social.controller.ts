import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { Public } from "../../common/decorators/public.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { BookSocialService } from "./book-social.service";

export class ReviewDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  text?: string;
}

@Controller()
export class BookSocialController {
  constructor(private readonly social: BookSocialService) {}

  // ── Izohlar ──────────────────────────────────────────────────────────────
  @Public()
  @Get("books/:id/reviews")
  list(@Param("id") id: string, @Query("page") page?: string, @Query("limit") limit?: string) {
    return this.social.listReviews(id, page ? Number(page) : 1, limit ? Number(limit) : 10);
  }

  @Get("books/:id/reviews/mine")
  mine(@Param("id") id: string, @CurrentUser("id") userId: string) {
    return this.social.myReview(id, userId);
  }

  // Spamga qarshi: daqiqasiga 5 ta yozish.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("books/:id/reviews")
  upsert(@Param("id") id: string, @CurrentUser("id") userId: string, @Body() dto: ReviewDto) {
    return this.social.upsertReview(id, userId, dto);
  }

  @Delete("reviews/:reviewId")
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param("reviewId") reviewId: string, @CurrentUser() user: { sub: string; role: string }) {
    return this.social.deleteReview(reviewId, user);
  }

  // ── Saralanganlar ────────────────────────────────────────────────────────
  @Get("favorites")
  favorites(@CurrentUser("id") userId: string) {
    return this.social.listFavorites(userId);
  }

  @Get("books/:id/favorite")
  isFavorite(@Param("id") id: string, @CurrentUser("id") userId: string) {
    return this.social.isFavorite(id, userId);
  }

  @Put("books/:id/favorite")
  add(@Param("id") id: string, @CurrentUser("id") userId: string) {
    return this.social.addFavorite(id, userId);
  }

  @Delete("books/:id/favorite")
  removeFavorite(@Param("id") id: string, @CurrentUser("id") userId: string) {
    return this.social.removeFavorite(id, userId);
  }
}
