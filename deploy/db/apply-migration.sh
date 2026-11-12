#!/bin/sh
# Applies one migration file to the database inside the db container.
#   docker compose exec db sh /dbtools/apply-migration.sh 003_risk_engine.sql
set -e
if [ -z "$1" ] || [ ! -f "/migrations/$1" ]; then
    echo "Give the name of a file in database/migrations, for example 003_risk_engine.sql"
    exit 1
fi
mysql -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" < "/migrations/$1"
echo "Applied $1"
