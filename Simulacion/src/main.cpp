#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <math.h>

// Wokwi VS Code (gateway privado integrado): NO usar localhost aqui.
const char* WIFI_SSID = "Wokwi-GUEST";
const char* API_URL = "http://host.wokwi.internal:3001/api/readings";
const char* DEVICE_TOKEN = "CONFIGURA_TOKEN";

#define PIN_TEMPERATURA 4
#define LED_VERDE 26
#define LED_AMARILLO 27
#define LED_ROJO 14
#define BUZZER 25

Adafruit_MPU6050 mpu;
OneWire oneWire(PIN_TEMPERATURA);
DallasTemperature ds18b20(&oneWire);

const float TEMP_ADVERTENCIA = 50.0;
const float TEMP_CRITICA = 70.0;
const float VIB_ADVERTENCIA = 2.0;
const float VIB_CRITICA = 5.0;

enum Estado { NORMAL, ADVERTENCIA, CRITICO };

void actualizarIndicadores(Estado estado) {
  digitalWrite(LED_VERDE, estado == NORMAL);
  digitalWrite(LED_AMARILLO, estado == ADVERTENCIA);
  digitalWrite(LED_ROJO, estado == CRITICO);
  if (estado == CRITICO) tone(BUZZER, 1500);
  else noTone(BUZZER);
}

void conectarWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, "", 6);
  Serial.print("Conectando a WiFi de Wokwi");
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) {
    delay(250);
    Serial.print('.');
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi conectado");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nWiFi no conectado; se reintentara durante el loop");
  }
}

void enviarLectura(float temperatura, float vibracion, float ax, float ay, float az) {

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Sin WiFi: lectura no enviada");
    WiFi.reconnect();
    return;
  }

  WiFiClient client;
  HTTPClient http;

  http.setTimeout(4000);

  if (!http.begin(client, API_URL)) {
    Serial.println("No se pudo abrir la URL de la API");
    return;
  }

  // Cabecera para enviar datos JSON
  http.addHeader("Content-Type", "application/json");

  // NUEVO: Autenticación del ESP32
  http.addHeader("X-Device-Token", DEVICE_TOKEN);

  // Construcción del JSON
  String body = "{\"motor_id\":\"MOTOR_01\",\"source\":\"esp32\",";
  body += "\"temperature_c\":" + String(temperatura, 2) + ",";
  body += "\"vibration_level\":" + String(vibracion, 3) + ",";
  body += "\"accel_x\":" + String(ax, 3) + ",";
  body += "\"accel_y\":" + String(ay, 3) + ",";
  body += "\"accel_z\":" + String(az, 3) + "}";

  // Enviar mediciones al servidor
  int code = http.POST(body);

  Serial.print("HTTP POST /api/readings -> ");
  Serial.println(code);

  if (code > 0) {
    Serial.println(http.getString());
  } else {
    Serial.println(http.errorToString(code));
  }

  http.end();
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_VERDE, OUTPUT);
  pinMode(LED_AMARILLO, OUTPUT);
  pinMode(LED_ROJO, OUTPUT);
  pinMode(BUZZER, OUTPUT);
  actualizarIndicadores(NORMAL);
  Wire.begin(21, 22);
  ds18b20.begin();
  if (!mpu.begin()) {
    Serial.println("ERROR: MPU6050 no detectado");
    actualizarIndicadores(CRITICO);
    while (true) delay(1000);
  }
  mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  conectarWifi();
  Serial.println("MotorWatch ESP32 iniciado");
}

void loop() {
  ds18b20.requestTemperatures();
  float temperatura = ds18b20.getTempCByIndex(0);
  sensors_event_t aceleracion, giroscopio, tempInterna;
  mpu.getEvent(&aceleracion, &giroscopio, &tempInterna);
  float ax = aceleracion.acceleration.x;
  float ay = aceleracion.acceleration.y;
  float az = aceleracion.acceleration.z;
  float magnitud = sqrt(ax * ax + ay * ay + az * az);
  float vibracion = fabs(magnitud - 9.81f);

  if (temperatura == DEVICE_DISCONNECTED_C || !isfinite(temperatura) ||
      !isfinite(vibracion) || !isfinite(ax) || !isfinite(ay) || !isfinite(az)) {
    Serial.println("Lectura de sensor invalida; no se enviara a la API");
    actualizarIndicadores(CRITICO);
    delay(5000);
    return;
  }

  Estado estado = NORMAL;
  if (temperatura >= TEMP_CRITICA || vibracion >= VIB_CRITICA) estado = CRITICO;
  else if (temperatura >= TEMP_ADVERTENCIA || vibracion >= VIB_ADVERTENCIA) estado = ADVERTENCIA;
  actualizarIndicadores(estado);
  Serial.printf("Temperatura %.2f C | Vibracion %.3f m/s2 | Estado %s\n",
    temperatura, vibracion, estado == CRITICO ? "CRITICO" : (estado == ADVERTENCIA ? "ADVERTENCIA" : "NORMAL"));
  enviarLectura(temperatura, vibracion, ax, ay, az);
  delay(5000);
}
