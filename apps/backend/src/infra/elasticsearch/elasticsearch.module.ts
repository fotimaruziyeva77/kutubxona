import { Module } from "@nestjs/common";
import { ElasticsearchModule } from "@nestjs/elasticsearch";
import { ConfigService } from "@nestjs/config";
import { SearchService } from "./elasticsearch.service";

@Module({
  imports: [
    ElasticsearchModule.registerAsync({
      useFactory: (configService: ConfigService) => ({
        node: configService.get<string>("ELASTICSEARCH_NODE") ?? "http://localhost:9200",
        // Fail-fast: ES ishlamayotgan bo'lsa har so'rov ~8s osilib qolmasin.
        // Prisma fallback baribir bor — tez uzilib unga o'tgani ma'qul.
        maxRetries: 1,
        requestTimeout: 2000,
        pingTimeout: 1000
      }),
      inject: [ConfigService]
    })
  ],
  providers: [SearchService],
  exports: [SearchService, ElasticsearchModule]
})
export class SearchModule {}