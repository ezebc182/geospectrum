"""
Invitaciones (email-invitations). Por ahora sólo el predicado compartido.

El servicio completo (crear/revocar/reenviar invitaciones, envío de emails)
llega en fases posteriores del cambio email-invitations — lo que vive acá
HOY es lo que el cierre del registro necesita: la definición única de
"invitación pendiente y vigente", importada por AuthService (design.md,
Decision "El cierre del registro"). Un solo lugar define el predicado; si
mañana cambia la semántica de vigencia, cambia acá y nada más.

Sin ciclo de imports: este módulo no importa auth_service (sólo constantes
y, a futuro, modelos).
"""

# Invitación consumible: no aceptada, no revocada, no vencida. Se interpola
# como fragmento SQL constante (NUNCA con datos del usuario) dentro de los
# UPDATE de consumo en auth_service.
PENDING_PREDICATE_SQL = "accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()"
