import {
  Controller,
  Get,
  Post,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
  ConflictException,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { promises as fs } from "fs";
import * as path from "path";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";

// ─────────────────────────────────────────────────────────────────────────────
// Tizimni yangilash (faqat SUPER_ADMIN).
//
// Joriy versiya — image yig'ilgandagi commit (APP_VERSION build-arg).
// Eng so'nggi versiya — GitHub'dagi oxirgi muvaffaqiyatli pilot-images yig'ilishi.
//
// "Yangilash" bosilganda backend serverdagi deploy/control papkasiga
// so'rov fayli yozadi; hostdagi systemd (deploy/install-updater.sh o'rnatadi)
// uni ko'rib deploy/update.sh ni ishga tushiradi. Backend hech qanday buyruq
// ishga tushirmaydi — faqat bitta qat'iy belgilangan skript chaqiriladi.
// ─────────────────────────────────────────────────────────────────────────────

const CONTROL_DIR = process.env.UPDATE_CONTROL_DIR || "/app/control";
const REPO = process.env.UPDATE_REPO || "fotimaruziyeva77/kutubxona";
const BRANCH = process.env.UPDATE_BRANCH || "feature/frontend-fixes";
const WORKFLOW = "pilot-images.yml";
const CHECK_TTL_MS = 5 * 60_000;

interface LatestInfo {
  sha: string;
  message: string;
  date: string;
}

@ApiTags("admin")
@ApiBearerAuth()
@Controller("admin/system")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class SystemUpdateController {
  private readonly logger = new Logger(SystemUpdateController.name);
  private cache: { at: number; latest: LatestInfo | null } | null = null;

  @Get("version")
  @ApiOperation({ summary: "Joriy va eng so'nggi versiya, yangilash holati" })
  async version() {
    const current = process.env.APP_VERSION || "dev";
    const latest = await this.fetchLatest();
    const updater = await this.updaterState();
    return {
      current,
      latest,
      updateAvailable: !!latest && current !== "dev" && latest.sha !== current,
      updater,
    };
  }

  @Post("update")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: "Serverda yangilashni boshlash (update.sh)" })
  async update() {
    const state = await this.updaterState();
    if (!state.installed) {
      throw new ServiceUnavailableException(
        "Avtomatik yangilash serverda o'rnatilmagan (deploy/install-updater.sh)"
      );
    }
    if (state.status === "running" || state.requested) {
      throw new ConflictException("Yangilash allaqachon ketmoqda");
    }
    await fs.writeFile(path.join(CONTROL_DIR, "update-request"), new Date().toISOString());
    this.logger.log("Yangilash so'rovi yozildi");
    return { started: true };
  }

  // Host skripti yozadigan holat: control/update-status (running|ok|failed),
  // control/update.log (oxirgi qatorlar), control/updater-installed (belgi).
  private async updaterState() {
    const read = (f: string) => fs.readFile(path.join(CONTROL_DIR, f), "utf8").catch(() => null);
    const [installed, requested, status, log] = await Promise.all([
      read("updater-installed"),
      read("update-request"),
      read("update-status"),
      read("update.log"),
    ]);
    return {
      installed: installed !== null,
      requested: requested !== null,
      status: status?.trim() || null,
      logTail: log ? log.trim().split("\n").slice(-15).join("\n") : null,
    };
  }

  private async fetchLatest(): Promise<LatestInfo | null> {
    if (this.cache && Date.now() - this.cache.at < CHECK_TTL_MS) return this.cache.latest;
    let latest: LatestInfo | null = null;
    try {
      const url =
        `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs` +
        `?branch=${encodeURIComponent(BRANCH)}&status=success&per_page=1`;
      const res = await fetch(url, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "sifat-library-updater" },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          workflow_runs?: { head_sha: string; updated_at: string; head_commit?: { message?: string } }[];
        };
        const run = data.workflow_runs?.[0];
        if (run) {
          latest = {
            sha: run.head_sha,
            message: (run.head_commit?.message || "").split("\n")[0].slice(0, 200),
            date: run.updated_at,
          };
        }
      } else {
        this.logger.warn(`GitHub versiya tekshiruvi: ${res.status}`);
      }
    } catch (e) {
      this.logger.warn(`GitHub versiya tekshiruvi xatosi: ${(e as Error).message}`);
    }
    this.cache = { at: Date.now(), latest };
    return latest;
  }
}
