# Puerta de seguridad para producción

- [ ] Autorización escrita del hospital y responsables de tratamiento.
- [ ] Condiciones contractuales, plan Railway y requisitos regulatorios aprobados.
- [ ] Región de PostgreSQL y volúmenes documentada.
- [ ] Retención, borrado y exportación aprobados.
- [ ] Restauración de backup cifrado probada y fechada.
- [ ] Plan de incidentes, contactos y plazos aprobado.
- [ ] Claves distintas, aleatorias, custodiadas y con rotación ensayada.
- [ ] FastAPI y PostgreSQL sin dominio público.
- [ ] HTTPS y `COOKIE_SECURE=true`.
- [ ] MFA verificado para administradores y decisión institucional documentada para médicos.
- [ ] Revisión de roles, bloqueo, expiración, CSRF y fuerza bruta.
- [ ] Prueba automatizada de ausencia de PHI en logs/errores/caché.
- [ ] PeruDevs autorizado para procesar DNI y política contractual revisada.
- [ ] OpenRouter y el proveedor visual autorizados; retención/ZDR y región documentadas.
- [ ] Radiografías revisadas para texto identificable incrustado fuera de los bordes.
- [ ] Benchmark CPU y límites de memoria/costo registrados.
- [ ] Staging aislado y limitado a datos sintéticos/desidentificados.

Hasta completar todos los puntos, producción debe permanecer bloqueada.
