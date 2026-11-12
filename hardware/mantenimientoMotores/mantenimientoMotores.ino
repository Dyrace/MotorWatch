#include <Wire.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <math.h>

// =====================================
// CONFIGURACION WIFI Y MOTORWATCH
// =====================================

// Cambia estos tres valores
const char* WIFI_SSID = "CONFIGURAR_WIFI";
const char* WIFI_PASSWORD = "CONFIGURAR_PASSWORD";
const char* DEVICE_TOKEN = "CONFIGURAR_TOKEN";

// IP actual de tu computadora
const char* MOTORWATCH_URL =
   "http://IP_DEL_SERVIDOR:3001";

const char* MOTOR_ID = "MOTOR_FISICO_01";

const unsigned long INTERVALO_ENVIO = 2000;
unsigned long ultimoEnvio = 0;
unsigned long ultimoIntentoWiFi = 0;

// =====================================
// PINES
// =====================================

#define LED_VERDE      16
#define LED_AMARILLO   17
#define LED_ROJO       18
#define BUZZER         19

#define DS18B20_PIN     4
#define MPU_ADDR     0x68

// =====================================
// TEMPERATURA
// =====================================

OneWire oneWire(DS18B20_PIN);
DallasTemperature ds18b20(&oneWire);

float temperatura = NAN;
unsigned long ultimoTiempoTemp = 0;
bool temperaturaValida = false;

// =====================================
// VIBRACION
// =====================================

float vibracion = 0;

float axAnterior = 0;
float ayAnterior = 0;
float azAnterior = 0;

bool primeraLectura = true;
bool mpuDisponible = false;

// =====================================
// TIEMPOS
// =====================================

unsigned long ultimoTiempoMPU = 0;
unsigned long ultimoReporte = 0;
unsigned long ultimoCambioBuzzer = 0;

bool buzzerEncendido = false;

// =====================================
// UMBRALES LOCALES DE PRUEBA
// =====================================

// Temperatura en grados Celsius
float TEMP_ADVERTENCIA = 22.0;
float TEMP_CRITICA = 25.0;

// Cambio de aceleracion suavizado
// NO es RMS industrial de vibracion
float VIB_ADVERTENCIA = 1.5;
float VIB_CRITICA = 3.5;

// =====================================
// ESTADOS
// =====================================

enum Estado {
  NORMAL,
  ADVERTENCIA,
  CRITICO,
  ERROR_SENSOR
};

Estado estadoActual = ERROR_SENSOR;

// =====================================
// MPU6050
// =====================================

bool iniciarMPU() {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x6B);
  Wire.write(0x00);

  if (Wire.endTransmission() != 0) {
    return false;
  }

  delay(100);

  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x1C);
  Wire.write(0x00);

  return Wire.endTransmission() == 0;
}

bool leerMPU(float &x, float &y, float &z) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);

  if (Wire.endTransmission(false) != 0) {
    return false;
  }

  if (Wire.requestFrom(MPU_ADDR, 6, true) != 6) {
    return false;
  }

  int16_t ax = (Wire.read() << 8) | Wire.read();
  int16_t ay = (Wire.read() << 8) | Wire.read();
  int16_t az = (Wire.read() << 8) | Wire.read();

  x = ax / 16384.0 * 9.81;
  y = ay / 16384.0 * 9.81;
  z = az / 16384.0 * 9.81;

  return true;
}

// =====================================
// LEDS
// =====================================

void actualizarLEDs(Estado estado) {
  digitalWrite(LED_VERDE, estado == NORMAL);
  digitalWrite(LED_AMARILLO, estado == ADVERTENCIA);
  digitalWrite(
    LED_ROJO,
    estado == CRITICO || estado == ERROR_SENSOR
  );
}

// =====================================
// BUZZER
// =====================================

void actualizarBuzzer(Estado estado) {
  unsigned long ahora = millis();

  if (estado == NORMAL) {
    buzzerEncendido = false;
    digitalWrite(BUZZER, LOW);
    ultimoCambioBuzzer = ahora;
    return;
  }

  unsigned long tiempoEncendido = 200;
  unsigned long tiempoApagado = 2800;

  if (estado == CRITICO) {
    tiempoEncendido = 250;
    tiempoApagado = 350;
  } else if (estado == ERROR_SENSOR) {
    tiempoEncendido = 100;
    tiempoApagado = 900;
  }

  unsigned long intervalo = buzzerEncendido
    ? tiempoEncendido
    : tiempoApagado;

  if (ahora - ultimoCambioBuzzer >= intervalo) {
    buzzerEncendido = !buzzerEncendido;

    digitalWrite(
      BUZZER,
      buzzerEncendido ? HIGH : LOW
    );

    ultimoCambioBuzzer = ahora;
  }
}

// =====================================
// EVALUAR ESTADO
// =====================================

Estado evaluarEstado() {
  if (!temperaturaValida || !mpuDisponible) {
    return ERROR_SENSOR;
  }

  if (temperatura >= TEMP_CRITICA ||
      vibracion >= VIB_CRITICA) {
    return CRITICO;
  }

  if (temperatura >= TEMP_ADVERTENCIA ||
      vibracion >= VIB_ADVERTENCIA) {
    return ADVERTENCIA;
  }

  return NORMAL;
}

const char* nombreEstado(Estado estado) {
  switch (estado) {
    case NORMAL:
      return "NORMAL";

    case ADVERTENCIA:
      return "ADVERTENCIA";

    case CRITICO:
      return "CRITICO";

    default:
      return "ERROR DE SENSOR";
  }
}

// =====================================
// CONEXION WIFI
// =====================================

void iniciarWiFi() {
  Serial.println("Conectando a Wi-Fi...");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  ultimoIntentoWiFi = millis();
}

void mantenerWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  unsigned long ahora = millis();

  if (ahora - ultimoIntentoWiFi >= 10000) {
    Serial.println("Reintentando Wi-Fi...");

    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    ultimoIntentoWiFi = ahora;
  }
}

// =====================================
// ENVIAR DATOS A MOTORWATCH
// =====================================

void enviarDatosMotorWatch() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println(
      "MotorWatch: Wi-Fi no conectado"
    );
    return;
  }

  // No enviar datos invalidos
  if (!temperaturaValida ||
      !mpuDisponible ||
      !isfinite(temperatura) ||
      !isfinite(vibracion)) {

    Serial.println(
      "MotorWatch: lectura no valida"
    );
    return;
  }

  HTTPClient http;

  // Limitar esperas por problemas de red
  http.setConnectTimeout(1000);
  http.setTimeout(1500);

  if (!http.begin(MOTORWATCH_URL)) {
    Serial.println(
      "MotorWatch: no se pudo iniciar HTTP"
    );
    return;
  }

  http.addHeader(
    "Content-Type",
    "application/json"
  );

  http.addHeader(
    "X-Device-Token",
    DEVICE_TOKEN
  );

  // Construir JSON
  String json = "{";

  json += "\"motor_id\":\"";
  json += MOTOR_ID;
  json += "\",";

  json += "\"source\":\"esp32_physical\",";

  json += "\"temperature_c\":";
  json += String(temperatura, 2);
  json += ",";

  json += "\"vibration_level\":";
  json += String(vibracion, 3);

  json += "}";

  Serial.println();
  Serial.println("Enviando a MotorWatch...");

  int codigo = http.POST(json);

  Serial.print("Codigo HTTP: ");
  Serial.println(codigo);

  if (codigo == 201) {
    Serial.println(
      "Medicion guardada correctamente"
    );
  } else if (codigo == 401) {
    Serial.println(
      "ERROR: clave del dispositivo invalida"
    );
  } else if (codigo == 400) {
    Serial.println(
      "ERROR: datos rechazados por el servidor"
    );
    Serial.println(http.getString());
  } else if (codigo > 0) {
    Serial.print("Respuesta: ");
    Serial.println(http.getString());
  } else {
    Serial.print("Error de conexion: ");
    Serial.println(http.errorToString(codigo));
  }

  http.end();
}

// =====================================
// SETUP
// =====================================

void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(LED_VERDE, OUTPUT);
  pinMode(LED_AMARILLO, OUTPUT);
  pinMode(LED_ROJO, OUTPUT);
  pinMode(BUZZER, OUTPUT);

  digitalWrite(LED_VERDE, LOW);
  digitalWrite(LED_AMARILLO, LOW);
  digitalWrite(LED_ROJO, LOW);
  digitalWrite(BUZZER, LOW);

  // Iniciar DS18B20
  ds18b20.begin();
  ds18b20.setResolution(10);
  ds18b20.setWaitForConversion(false);
  ds18b20.requestTemperatures();

  ultimoTiempoTemp = millis();

  // Iniciar MPU6050
  Wire.begin(21, 22);
  Wire.setClock(100000);
  Wire.setTimeOut(50);

  mpuDisponible = iniciarMPU();

  Serial.println();
  Serial.println("==========================");
  Serial.println("       MOTORWATCH");
  Serial.println(" MANTENIMIENTO PREDICTIVO");
  Serial.println("==========================");

  Serial.println(
    mpuDisponible
      ? "MPU6050: INICIADO"
      : "MPU6050: NO DETECTADO"
  );

  // Iniciar Wi-Fi sin detener sensores
  iniciarWiFi();
}

// =====================================
// LOOP PRINCIPAL
// =====================================

void loop() {
  unsigned long ahora = millis();

  // ---------------------------------
  // TEMPERATURA CADA 1 SEGUNDO
  // ---------------------------------

  if (ahora - ultimoTiempoTemp >= 1000) {
    float lectura = ds18b20.getTempCByIndex(0);

    temperaturaValida =
      lectura != DEVICE_DISCONNECTED_C &&
      lectura >= -55.0 &&
      lectura <= 125.0;

    if (temperaturaValida) {
      temperatura = lectura;
    } else {
      temperatura = NAN;
    }

    ds18b20.requestTemperatures();
    ultimoTiempoTemp = ahora;
  }

  // ---------------------------------
  // MPU6050 CADA 50 MILISEGUNDOS
  // ---------------------------------

  if (ahora - ultimoTiempoMPU >= 50) {
    ultimoTiempoMPU = ahora;

    float x, y, z;

    if (leerMPU(x, y, z)) {
      mpuDisponible = true;

      if (!primeraLectura) {
        float dx = x - axAnterior;
        float dy = y - ayAnterior;
        float dz = z - azAnterior;

        float cambio = sqrt(
          dx * dx +
          dy * dy +
          dz * dz
        );

        vibracion =
          0.8 * vibracion +
          0.2 * cambio;
      }

      axAnterior = x;
      ayAnterior = y;
      azAnterior = z;

      primeraLectura = false;

    } else {
      mpuDisponible = false;
      primeraLectura = true;
      vibracion = 0;
    }
  }

  // ---------------------------------
  // ESTADO DEL SISTEMA
  // ---------------------------------

  Estado nuevoEstado = evaluarEstado();

  if (nuevoEstado != estadoActual) {
    estadoActual = nuevoEstado;

    digitalWrite(BUZZER, LOW);
    buzzerEncendido = false;
    ultimoCambioBuzzer = ahora;
  }

  actualizarLEDs(estadoActual);
  actualizarBuzzer(estadoActual);

  // ---------------------------------
  // MONITOR SERIE CADA 1 SEGUNDO
  // ---------------------------------

  if (ahora - ultimoReporte >= 1000) {
    ultimoReporte = ahora;

    Serial.println("--------------------------");

    Serial.print("Temperatura: ");

    if (temperaturaValida) {
      Serial.print(temperatura, 2);
      Serial.println(" C");
    } else {
      Serial.println("SIN LECTURA");
    }

    Serial.print("Vibracion: ");

    if (mpuDisponible) {
      Serial.print(vibracion, 3);
      Serial.println(" m/s^2");
    } else {
      Serial.println("SIN LECTURA");
    }

    Serial.print("Estado: ");
    Serial.println(nombreEstado(estadoActual));

    if (WiFi.status() == WL_CONNECTED) {
      Serial.print("Wi-Fi conectado. IP: ");
      Serial.println(WiFi.localIP());
    } else {
      Serial.println("Wi-Fi desconectado");
    }
  }

  // ---------------------------------
  // MANTENER CONEXION WIFI
  // ---------------------------------

  mantenerWiFi();

  // ---------------------------------
  // ENVIAR A MOTORWATCH CADA 2 SEGUNDOS
  // ---------------------------------

  if (ahora - ultimoEnvio >= INTERVALO_ENVIO) {
    ultimoEnvio = ahora;
    enviarDatosMotorWatch();
  }
}