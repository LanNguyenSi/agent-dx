.ONESHELL:

DC = docker compose
COMPOSER := composer
PHPUNIT := ./tools/vendor/bin/phpunit
PHPSTAN := ./tools/vendor/bin/phpstan
PHP_CS_FIXER := ./tools/vendor/bin/php-cs-fixer
PHPCS := ./tools/vendor/bin/phpcs
MESS_DETECTOR := ./tools/vendor/bin/phpmd

COMPOSER_FLAGS := --no-interaction --prefer-dist
PHPUNIT_CONFIG := ./tools/phpunit.xml.dist
PHPSTAN_CONFIG := ./tools/phpstan.neon.dist
PHPCS_STANDARD := PSR12
PHP_CS_FIXER_RULES := @PSR12

help: ## Show this help message
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-25s\033[0m %s\n", $$1, $$2}'

composer-update: ## Update PHP dependencies
	$(COMPOSER) update $(COMPOSER_FLAGS)

run-cs-fixer: ## Run PHP CS Fixer
	$(PHP_CS_FIXER) --rules=$(PHP_CS_FIXER_RULES) --diff src/

#############
## Linting ##
#############

lint-phpcs: ## Run PHP CodeSniffer
	$(PHPCS) --standard=$(PHPCS_STANDARD) src/

lint-cs-fixer: ## Run PHP CS Fixer dry-run only
	$(PHP_CS_FIXER) dry-run --rules=$(PHP_CS_FIXER_RULES) --diff src/

lint-md: ## PHP Mess Detector
	@$(MESS_DETECTOR) text src/

lint-phpstan: ## Run PHPStan
	$(PHPSTAN) analyse --configuration=$(PHPSTAN_CONFIG) --error-format=json --no-progress

lint: lint-phpcs lint-cs-fixer lint-md lint-phpstan ## Run all linters

###########
## Tests ##
###########

test-unit: ## Run unit tests
	@$(PHPUNIT) --configuration $(PHPUNIT_CONFIG) --testsuite unit

test-integration: ## Run integration tests
	@$(PHPUNIT) --configuration $(PHPUNIT_CONFIG) --testsuite integration

test: test-unit test-integration

############
## Docker ##
############

docker-build: ## Build Docker images
	@echo "Building app Docker image..."
	docker build --target dev --tag app:prod build/app/
	@echo "Building nginx Docker image..."
	docker build --target dev --tag nginx:prod build/nginx/

docker-up: ## Start application with Docker Compose
	$(DC) up -d

docker-stop: ## Stop dev environment
	$(DC) stop ${containers}

docker-restart: ## Restart dev environment
	$(DC) restart ${containers}

docker-down: ## Down dev environment
	$(DC) down --remove-orphans

destroy: ## Destroy dev environment
	@echo -n "Are you sure? [y/N] " && read ans && [ $${ans:-N} = y ]
	$(DC) down --volumes --remove-orphans --rmi all

docker-logs: ## Show application logs
	$(DC) logs -f

status: ## Show docker status
	$(DC) ps -a
