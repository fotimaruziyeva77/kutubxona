import { Module, Global } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { KafkaService } from "./kafka.service";
import { KafkaConsumerService } from "./kafka-consumer.service";
import { GatewayModule } from "../gateway/gateway.module";

@Global()
@Module({
  imports: [ConfigModule, GatewayModule],
  providers: [KafkaService, KafkaConsumerService],
  exports: [KafkaService],
})
export class KafkaModule {}
