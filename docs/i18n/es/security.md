# Política de seguridad

## Versiones compatibles

Solo la última versión publicada de `leina` recibe correcciones de seguridad.

## Cómo reportar una vulnerabilidad

Por favor **no abra un issue público** para reportes de seguridad. En su lugar, use el
reporte privado de vulnerabilidades de GitHub (pestaña "Security" → "Report a vulnerability")
en este repositorio. Debería recibir un acuse de recibo en cuestión de días.

## Notas de alcance para investigadores

- leina es **local-first**: no realiza llamadas de red en tiempo de ejecución (construir un
  sidecar de Java/C# es la única operación que descarga algo, y lo hace a través del
  toolchain local o de un mirror configurable).
- `~/.leina/.env` almacena las credenciales de servicio en **texto plano con permisos 0600**
  por diseño; el modelo de amenaza consiste en mantener los valores fuera de argv, el
  historial de la shell y el contexto del agente de IA (el contrato "names, not values") —
  no el cifrado en reposo. Los reportes que asuman que se pretende cifrado en reposo se
  cerrarán como comportamiento por diseño, pero los reportes de fuga de valores a través de
  argv/stdout/logs están completamente dentro del alcance.
- Los hallazgos de `leina audit` son rutas candidatas para triaje, no vulnerabilidades
  confirmadas.
