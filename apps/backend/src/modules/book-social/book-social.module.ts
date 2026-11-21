import { Module } from "@nestjs/common";
import { AppInfraModule } from "../../infra/app-infra.module";
import { BookSocialController } from "./book-social.controller";
import { BookSocialService } from "./book-social.service";

@Module({
  imports: [AppInfraModule],
  controllers: [BookSocialController],
  providers: [BookSocialService]
})
export class BookSocialModule {}
