# Panel Activacion TV

Este panel sirve para activar dispositivos de la APK y cargar la linea que usara cada TV Box.

Usa la tabla `apk_config` de Supabase, la misma que consulta la APK.

## Campos que usa

- `device_id`
- `activo`
- `tipo` con valor `xtream` o `m3u`
- `servidor`
- `usuario`
- `password`
- `m3u_url`
- `caduca`

## Probar en el ordenador

Primero configura la clave de Supabase:

```text
CONFIGURAR_SUPABASE.bat
```

Se abrira un bloc de notas. Cambia `PEGA_AQUI_LA_CLAVE_SERVICE_ROLE` por tu clave secreta de Supabase y guarda.

Entra en esta carpeta y arranca:

```powershell
npm.cmd start
```

Abre:

```text
http://localhost:3000
```

Usuario por defecto:

```text
admin
```

Contrasena local por defecto:

```text
admin123
```

## Subirlo online en Render

1. Sube esta carpeta a GitHub.
2. En Render crea un `Web Service`.
3. Pon como comando de inicio:

```text
npm start
```

4. En variables de entorno pon:

```text
ADMIN_USER=admin
ADMIN_PASSWORD=TU_CONTRASENA_PRIVADA
SUPABASE_URL=https://osxacblrlhbclxrwxlfv.supabase.co
SUPABASE_SERVICE_ROLE_KEY=TU_CLAVE_SECRETA_DE_SUPABASE
SUPABASE_TABLE=apk_config
SUPABASE_DEVICE_TABLE=dispositivos
SUPABASE_LINE_TABLE=lineas
```

La clave `SUPABASE_SERVICE_ROLE_KEY` es privada. No va dentro de la APK ni dentro de una pagina publica.

## Si sale: cannot insert into view "apk_config"

Eso significa que `apk_config` no es una tabla, es una vista. La APK puede leerla, pero el panel necesita guardar en la tabla real.

En Supabase abre `SQL Editor` y ejecuta:

```sql
select definition
from pg_views
where schemaname = 'public'
  and viewname = 'apk_config';
```

En el resultado mira el nombre que aparece despues de `from public.`. Ese es el nombre de la tabla real.

Despues abre `CONFIGURAR_SUPABASE.bat` y cambia:

```text
SUPABASE_TABLE=apk_config
```

por el nombre de la tabla real, por ejemplo:

```text
SUPABASE_TABLE=nombre_de_tu_tabla
```

Guarda, cierra el panel y vuelve a abrir `ARRANCAR_PANEL.bat`.

## Como se usa

1. Copia el ID que te muestra la APK en el TV Box.
2. En el panel, pega ese ID en `ID del dispositivo`.
3. Activa el cliente.
4. Elige `Xtream` o `M3U`.
5. Guarda.
6. Abre la APK en el TV Box y cargara la linea de ese dispositivo.
