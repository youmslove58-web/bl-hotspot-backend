# ============================================================
# B&L Info Service - Hotspot v4 - MikroTik Sync Script
# ============================================================
# Ce script tourne sur le MikroTik et interroge le backend Render
# pour recuperer les utilisateurs hotspot a creer.
#
# Architecture: MikroTik PULL (le MikroTik tire les donnees)
#
# Installation:
# 1. Copiez ce script dans /system/script sur votre MikroTik
# 2. Modifiez les variables ci-dessous
# 3. Ajoutez un scheduler pour executer toutes les 10 secondes
#
# Scheduler:
# /system/scheduler add name=bl-hotspot-sync interval=10s \
#   on-event="/system/script/run bl-hotspot-sync" policy=read,write,test
# ============================================================

# --- CONFIGURATION (MODIFIEZ CES VALEURS) ---
:local backendUrl "https://bl-hotspot-backend.onrender.com"
:local syncToken "hotspot-sync-change-moi-aussi"

# --- NE PAS MODIFIER CI-DESSOUS ---

:log info "BL-Hotspot Sync: Debut de la synchronisation..."

# ============================================================
# Etape 1: Recuperer les utilisateurs en attente
# ============================================================
:local fetchResult
:do {
    :set fetchResult [/tool/fetch url=("$backendUrl/api/sync/pending?token=$syncToken") mode=https output=user as-value];
} on-error={
    :log warning "BL-Hotspot Sync: Impossible de joindre le backend";
    :error "Backend inaccessible";
}

:local responseData ($fetchResult->"data")
:local success false

# Parser le JSON pour verifier le success
:do {
    :local jsonData [:json $responseData]
    :if ([:typeof $jsonData] = "array" || [:typeof $jsonData] = "nothing") do={
        # Le JSON est un objet, pas un tableau
    }
    :if (($jsonData->"success") = true || ($jsonData->"success") = "true") do={
        :set success true
    }
} on-error={
    :log warning "BL-Hotspot Sync: Erreur de parsing JSON";
}

:if (!$success) do={
    :log warning "BL-Hotspot Sync: Le backend a retourne une erreur";
    :error "Backend error";
}

# ============================================================
# Etape 2: Extraire et creer chaque utilisateur
# ============================================================
:local usersToCreate [:json $responseData]
:local userData ($usersToCreate->"data")
:local userCount [:len $userData]

:if ($userCount = 0) do={
    :log info "BL-Hotspot Sync: Aucun utilisateur en attente";
}

:local confirmedIds ""

:for i from=0 to=($userCount - 1) do={
    :local user ($userData->$i)
    :local username ($user->"username")
    :local password ($user->"password")
    :local profile ($user->"profile")
    :local comment ($user->"comment")
    :local syncId ($user->"syncId")

    :if ([:typeof $username] = "string" && [:typeof $password] = "string" && [:typeof $profile] = "string") do={
        # Verifier si l'utilisateur existe deja
        :local exists false
        :do {
            :local existing [/ip/hotspot/user find name=$username]
            :if ([:len $existing] > 0) do={
                :set exists true
            }
        } on-error={}

        :if (!$exists) do={
            # Creer l'utilisateur hotspot
            :do {
                /ip/hotspot/user/add name=$username password=$password profile=$profile comment=$comment
                :log info ("BL-Hotspot Sync: Utilisateur cree: " . $username . " (profile: " . $profile . ")")
            } on-error={
                :log warning ("BL-Hotspot Sync: Erreur creation utilisateur: " . $username)
            }
        } else={
            :log info ("BL-Hotspot Sync: Utilisateur deja existant: " . $username)
        }

        # Ajouter le syncId a la liste des confirmations
        :if ([:len $confirmedIds] = 0) do={
            :set confirmedIds ("\"" . $syncId . "\"")
        } else={
            :set confirmedIds ($confirmedIds . ", \"" . $syncId . "\"")
        }
    }
}

# ============================================================
# Etape 3: Confirmer au backend les utilisateurs crees
# ============================================================
:if ([:len $confirmedIds] > 0) do={
    :local confirmBody ("{\"syncIds\":[" . $confirmedIds . "]}")
    
    :do {
        /tool/fetch url=("$backendUrl/api/sync/confirm?token=$syncToken") \
            mode=https \
            http-method=post \
            http-data=$confirmBody \
            http-header-field="Content-Type: application/json" \
            output=none
        :log info ("BL-Hotspot Sync: Confirmation envoyee pour " . [:len [ :toarray $confirmedIds ]] . " utilisateurs")
    } on-error={
        :log warning "BL-Hotspot Sync: Erreur lors de l'envoi de la confirmation"
    }
}

:log info "BL-Hotspot Sync: Synchronisation terminee"
