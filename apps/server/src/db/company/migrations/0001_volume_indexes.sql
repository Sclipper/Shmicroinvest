CREATE INDEX "ix_initial_balances_accounting" ON "account_initial_balances" USING btree ("accounting_id");--> statement-breakpoint
CREATE INDEX "ix_attachments_accounting" ON "accounting_attachments" USING btree ("accounting_id");--> statement-breakpoint
CREATE INDEX "ix_details_ref_account" ON "accounting_details" USING btree ("ref_account_id");--> statement-breakpoint
CREATE INDEX "ix_extended_details_accounting" ON "accounting_extended_details" USING btree ("accounting_id");--> statement-breakpoint
CREATE INDEX "ix_apd_document" ON "accounting_payment_details" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "ix_bank_imported_rows_accounting" ON "bank_imported_rows" USING btree ("accounting_id");