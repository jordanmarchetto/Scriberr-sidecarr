import fs from "node:fs";
import mqtt from "mqtt";
const values = {};
for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
  const [key, ...rest] = trimmed.split("=");
  values[key] = rest.join("=").replace(/^["']|["']$/g, "");
}
const bool = (value) => ["1", "true", "yes", "on"].includes((value || "").toLowerCase());
const client = mqtt.connect(values.SIDECARR_MQTT_URL, {
  username: values.SIDECARR_MQTT_USERNAME,
  password: values.SIDECARR_MQTT_PASSWORD,
  connectTimeout: 10000,
  reconnectPeriod: 0
});
const timeout = setTimeout(() => {
  console.error("MQTT test timed out");
  client.end(true);
  process.exit(1);
}, 15000);
client.once("error", (error) => {
  clearTimeout(timeout);
  console.error("MQTT test failed:", error.message);
  client.end(true);
  process.exit(1);
});
client.once("connect", () => {
  const event = {
    event: "transcription_complete",
    job_id: "00000000-0000-4000-8000-000000000001",
    status: "completed",
    source: "manual-test",
    attempt: 1,
    occurred_at: new Date().toISOString(),
    scriberr_url: values.SIDECARR_SCRIBERR_URL
  };
  const topic = values.SIDECARR_MQTT_TOPIC_PREFIX.replace(/\/$/, "") + "/transcription_complete";
  client.publish(topic, JSON.stringify(event), {
    qos: Number(values.SIDECARR_MQTT_QOS || 1),
    retain: bool(values.SIDECARR_MQTT_RETAIN)
  }, (error) => {
    clearTimeout(timeout);
    if (error) {
      console.error("MQTT publish failed:", error.message);
      client.end(true);
      process.exit(1);
    }
    console.log(JSON.stringify({ published: true, topic, event }));
    client.end(false, {}, () => process.exit(0));
  });
});