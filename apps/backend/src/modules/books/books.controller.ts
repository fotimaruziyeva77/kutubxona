import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  HttpCode,
  HttpStatus,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { ApiQuery } from "@nestjs/swagger";
import { FileInterceptor } from "@nestjs/platform-express";
import { BooksService, CreateBookDto, UpdateBookDto, SearchBooksDto } from "./books.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { UserRole } from "@prisma/client";

@Controller("books")
export class BooksController {
  constructor(private readonly booksService: BooksService) {}

  // ── Ochiq qidiruv endpointlari (auth kerak emas — @Public, INFRA-03) ──────
  // AUDIT-REPORT M16 — majburiy pagination (default 50, max 200); javob
  // shakli (massiv) o'zgarmagan, mavjud chaqiruvchilar buzilmaydi.
  @Public()
  @Get()
  @ApiQuery({ name: "libraryId", required: false })
  @ApiQuery({ name: "page", required: false, description: "Sahifa (default 1)" })
  @ApiQuery({ name: "limit", required: false, description: "Sahifa hajmi (default 50, max 200)" })
  findAll(
    @Query("libraryId") libraryId?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string
  ) {
    return this.booksService.findAll(
      libraryId,
      page !== undefined ? Number(page) : undefined,
      limit !== undefined ? Number(limit) : undefined
    );
  }

  @Public()
  @Get("search")
  @ApiQuery({ name: "lat", required: false, description: "Foydalanuvchi joylashuvi (latitude) — yaqin do'konlarni saralash uchun" })
  @ApiQuery({ name: "lon", required: false, description: "Foydalanuvchi joylashuvi (longitude) — yaqin do'konlarni saralash uchun" })
  search(@Query() dto: SearchBooksDto) {
    return this.booksService.search(dto);
  }

  @Public()
  @Get("isbn/:isbn")
  lookupIsbn(@Param("isbn") isbn: string) {
    return this.booksService.lookupIsbn(isbn);
  }

  @Get("scan/:sifatId")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.KUTUBXONACHI, UserRole.MUASSASA_ADMIN, UserRole.SUPER_ADMIN)
  scanQr(@Param("sifatId") sifatId: string) {
    return this.booksService.scanUserQr(sifatId);
  }

  // Kitob import shabloni (.xlsx) — kutubxonachi/muassasa admini to'ldirib
  // yuklash uchun. `:id` dan OLDIN turishi shart (aks holda "template" id deb
  // qabul qilinadi).
  @Get("template")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN, UserRole.KUTUBXONACHI)
  async downloadTemplate(@Res() res: Response) {
    const buf = await this.booksService.buildBookTemplate();
    res.set({
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="sifat-kitob-shablon.xlsx"',
      "Content-Length": String(buf.length),
    });
    res.end(buf);
  }

  @Public()
  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.booksService.findOne(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.KUTUBXONACHI, UserRole.MUASSASA_ADMIN, UserRole.SUPER_ADMIN)
  create(@Body() dto: CreateBookDto) {
    return this.booksService.create(dto);
  }

  // BOOK-01 (Plan 02-04): Excel import is now async via BOOK_IMPORT_QUEUE.
  // The HTTP request returns 202 + { jobId } immediately; the UI polls
  // GET /books/import/:jobId/status for progress and final results.
  @Post("import")
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.KUTUBXONACHI, UserRole.MUASSASA_ADMIN, UserRole.SUPER_ADMIN)
  @UseInterceptors(FileInterceptor("file"))
  importExcel(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }), // 10MB
          new FileTypeValidator({ fileType: /(xlsx|xls|spreadsheet)/ })
        ]
      })
    )
    file: Express.Multer.File & { buffer: Buffer },
    @Query("libraryId") libraryId: string,
    @CurrentUser("id") userId: string
  ) {
    return this.booksService.enqueueImport(file.buffer, libraryId, userId);
  }

  @Get("import/:jobId/status")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.KUTUBXONACHI, UserRole.MUASSASA_ADMIN, UserRole.SUPER_ADMIN)
  getImportStatus(@Param("jobId") jobId: string) {
    return this.booksService.getImportStatus(jobId);
  }

  @Put(":id")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.KUTUBXONACHI, UserRole.MUASSASA_ADMIN, UserRole.SUPER_ADMIN)
  update(@Param("id") id: string, @Body() dto: UpdateBookDto) {
    return this.booksService.update(id, dto);
  }

  @Delete(":id")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.MUASSASA_ADMIN, UserRole.SUPER_ADMIN)
  remove(@Param("id") id: string) {
    return this.booksService.remove(id);
  }
}
