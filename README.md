# MotorWatch — Etapa 2 (API + SQLite)

## Requisitos
Windows, VS Code, Node.js LTS y npm.

## Iniciar
1. Abre esta carpeta en VS Code.
2. En terminal ejecuta `npm install`.
3. Ejecuta `npm run dev:all`.
4. Abre `http://localhost:5173`.
5. Para el teléfono, conéctalo a la misma red Wi-Fi y abre `http://IP_DE_TU_PC:5173` (IP obtenida con `ipconfig`).

**Nota:** la API escucha solo en `127.0.0.1:3001`; Vite hace de proxy `/api` desde la web para que el teléfono no necesite conectarse directamente al puerto 3001. El acceso por Wi-Fi depende de la configuración de red y del firewall de Windows.

## Endpoints
- `GET /api/health`
- `GET /api/readings?limit=100`
- `GET /api/latest`
- `GET /api/alerts`
- `POST /api/readings`

Ejemplo PowerShell (en otra terminal):

```powershell
Invoke-RestMethod -Uri http://localhost:3001/api/readings -Method Post -ContentType 'application/json' -Body '{"motor_id":"MOTOR_01","source":"simulation","temperature_c":54.2,"vibration_level":2.3}'
```

Los estados se calculan en el servidor con umbrales fijos de demostración: temperatura 50/70 °C y vibración 2/5 m/s². Los cambios en Configuración son visuales y **no** modifican los umbrales del servidor.

## Base de datos
Se crea automáticamente `server/data/motorwatch.sqlite` usando SQLite vía `sql.js` (WebAssembly). Se guarda al insertar cada lectura. No borres el archivo si deseas conservar el historial.

## Limitaciones
La simulación sigue generando lecturas desde el navegador; el ESP32 aún no está conectado. El historial visible muestra hasta 100 lecturas recientes. No hay autenticación: úsalo solo en una red privada de confianza para pruebas; no publiques el servidor en Internet. La fórmula de vibración es un indicador simplificado y el sistema todavía no es un modelo predictivo.
