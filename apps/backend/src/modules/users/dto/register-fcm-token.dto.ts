import { IsIn, IsString, Length, Matches } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

/**
 * Plan 05-04 Task 3 — POST /users/me/fcm-token DTO.
 *
 * FCM registration tokens are URL-safe base64 with `:` separators (typically
 * 152-163 bytes). The Length(100, 250) + Matches(/^[A-Za-z0-9_:.-]+$/) pair
 * matches the FCM spec while rejecting obvious garbage.
 *
 * Platform is a closed enum so a misconfigured client cannot inject arbitrary
 * strings into the DeviceToken.platform column.
 */
export class RegisterFcmTokenDto {
  @ApiProperty({
    example: "ej...:APA91bF...",
    description: "FCM device registration token from Firebase SDK",
  })
  @IsString()
  @Length(100, 250)
  @Matches(/^[A-Za-z0-9_:.-]+$/, {
    message: "Token must contain only URL-safe characters (A-Z, a-z, 0-9, _, :, ., -)",
  })
  token!: string;

  @ApiProperty({ example: "web", enum: ["web", "android", "ios"] })
  @IsIn(["web", "android", "ios"])
  platform!: "web" | "android" | "ios";
}
