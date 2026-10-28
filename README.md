# Backend DashGuard

Esta copia parte del server.js original. Conserva GET /mediciones (respuesta
`{mediciones: [...]}`) y las rutas de recorridos. El frontend compartido espera
un arreglo directo: esa incompatibilidad previa sigue pendiente de corregir.

## Orden de instalacion

1. Aplicar `base-de-datos/001_preparar_sincronizacion.sql` una sola vez (ya aplicado).
2. Aplicar `base-de-datos/002_recorridos_sincronizacion.sql` en Supabase SQL Editor.
3. En Windows PowerShell, dentro de esta carpeta: `npm ci`.
4. Copiar `.env.example` a `.env` y configurar SUPABASE_URL y SUPABASE_KEY
   exclusivamente en el servidor; no guardar claves en Git ni en la Raspberry.
5. Ejecutar `npm test` y `npm start`. Todavia no se desplego en Render.

## POST /mediciones

El formato anterior del ESP32 sigue siendo valido. Para sincronizar, incluir
`muestra_id` (UUID estable), `fecha_hora` (ISO UTC con Z y hasta milisegundos)
y opcionalmente `recorrido_id`, los seis ejes y `velocidad_kmh`.
`valor` conserva la magnitud de aceleracion; no mezclarla con velocidad.

```json
{
  "device_id": "dashguard-pi-001",
  "muestra_id": "318cc36d-a96d-40b2-b168-6eb13e130adc",
  "fecha_hora": "2026-10-21T18:29:45Z",
  "recorrido_id": null,
  "variable": "aceleracion",
  "valor": 9.81,
  "unidad": "m/s2",
  "source": "mpu6050",
  "ax_ms2": 0,
  "ay_ms2": 0,
  "az_ms2": 9.81,
  "gx_grados_s": 0,
  "gy_grados_s": 0,
  "gz_grados_s": 0,
  "gps_valido": false,
  "velocidad_kmh": null
}
```

- 201: nueva muestra. 200 con `duplicada: true`: mismo UUID y contenido ya guardado.
- 409: UUID reutilizado con contenido distinto. No marcar como enviada.
- 400: formato invalido. 422: restriccion de datos o recorrido incompatible.
- Fallo de red o 5xx: conservar pendiente y reintentar exactamente el mismo UUID
  y contenido. El cliente debe verificar el UUID/dispositivo de la respuesta
  antes de marcar enviado. El sincronizador SQLite aun no esta implementado.

No se actualiza una muestra al reintentar. created_at es recepcion; fecha_hora
es captura. Con UUID y recorrido null el trigger no asigna el recorrido activo.
Con recorrido explicito comprueba dispositivo y fechas. Los recorridos offline
aun no se crean/sincronizan: por ahora enviar null. Los envios sin UUID conservan
la asignacion automatica anterior. Cada tipo de dispositivo debe tener ID propio.

Las pruebas usan una base simulada para la logica de reintentos y validacion.
Falta comprobar la migracion y el flujo HTTP contra Supabase real; no afirman
validar concurrencia ni ejecucion de triggers de PostgreSQL. La API conserva
el acceso sin autenticacion del prototipo; falta autenticar dispositivos para
uso fuera de pruebas controladas.
# Entrega dashcam offline (28 de octubre de 2026)

El backend requiere Node 24 y cinco variables: SUPABASE_URL, SUPABASE_KEY
(servidor, con acceso service_role), DASHCAM_DEVICE_ID, DASHCAM_DEVICE_TOKEN y
DASHCAM_OWNER_TOKEN. Tokens diferentes, aleatorios y de al menos 32 caracteres.
Sin configuracion valida no inicia. No colocar claves en frontend ni Git.

Aplicar `base-de-datos/003_dashcam_offline.sql` del repositorio consolidado. Agrega
tabla con RLS y bucket privado sin alterar tablas anteriores.

`GET /` solo expone salud/version. Todas las demas rutas requieren Bearer:
propietario para GET; dispositivo para POST/PUT. Endpoints nuevos:
POST /dashcam/registros, PUT /dashcam/videos/:recorrido/:video,
GET /dashcam/recorridos, GET /dashcam/recorridos/:id?offset=0,
GET /dashcam/videos/:id (URL privada temporal de 300 s).
La subida admite hasta 8 MiB por segmento; verifica SHA256 y nunca sobrescribe
un objeto distinto con el mismo ID. Una subida interrumpida se reintenta completa.
La cola solo confirma tras validar UUID, dispositivo, checksum y bytes.

El frontend local se abre en `/dashcam.html` y no guarda la clave. La pagina
historica queda como prototipo; ahora necesita autenticar sus llamadas antiguas.
Para comprobar API y Supabase juntos: `node verificar-api.cjs --local`.
Para comprobar despliegue: `node verificar-api.cjs https://dashguard-backend.onrender.com`.
Estas pruebas conservan un recorrido marcado como sintetico, sin datos de hardware.

Render sigue conectado al repositorio historico `vkgtzs/dashguard-backend`.
La fuente de desarrollo es `vkgtzs/dashguard/backend`; publicar una copia de los
archivos del backend, conservando historial y excluyendo todos los .env reales.
