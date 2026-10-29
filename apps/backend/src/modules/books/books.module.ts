import { Module } from "@nestjs/common";
import { MulterModule } from "@nestjs/platform-express";
import { BooksController } from "./books.controller";
import { BooksService } from "./books.service";
import { BookImportProcessor } from "./books-import.processor";
import { AppInfraModule } from "../../infra/app-infra.module";
import { QueueModule } from "../../infra/queue/queue.module";
import { StoreModule } from "../store/store.module";

@Module({
  imports: [
    AppInfraModule,
    QueueModule,
    StoreModule,
    MulterModule.register({ limits: { fileSize: 10 * 1024 * 1024 } })
  ],
  controllers: [BooksController],
  providers: [BooksService, BookImportProcessor],
  exports: [BooksService]
})
export class BooksModule {}
