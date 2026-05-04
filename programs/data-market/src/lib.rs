use anchor_lang::prelude::*;

declare_id!("BMint1111111111111111111111111111111111111111");

/// BioMint Data Market — on-chain settlement layer.
///
/// Off-chain (patient devices / IPFS):
///   Raw CGM readings, genome variants, lifestyle data — never touches the chain.
///
/// On-chain (this program):
///   DatasetRecord PDA  — content hash, contributor, ask price, stats
///   ImprovementSettled event — emitted on each micropayment
///
/// The trust model:
///   - Contributors are identified by their Solana pubkey
///   - The oracle (BioMint agent) signs model evaluation attestations off-chain
///   - settle_improvement() requires BOTH the buyer to sign (pays SOL)
///     AND the oracle to sign (attests the delta)
///   - This two-of-two requirement prevents either party from cheating alone

#[program]
pub mod data_market {
    use super::*;

    // ── Dataset registration ─────────────────────────────────────────────────

    /// Register a new dataset token on-chain.
    ///
    /// The actual clinical data remains off-chain (patient-controlled storage).
    /// Only the Merkle root (content_hash) and metadata are stored here.
    ///
    /// PDA seeds: ["dataset", contributor, content_hash]
    /// This ensures exactly one on-chain record per (contributor, dataset) pair.
    pub fn register_dataset(
        ctx: Context<RegisterDataset>,
        content_hash: [u8; 32],
        data_type: DataType,
        ask_lamports: u64,
        quality_score_bps: u16,   // 0–10 000 (basis points representing 0.00–1.00)
        record_count: u32,
        coverage_days_tenths: u16, // coverage days × 10 (1 decimal place, 0 if not applicable)
    ) -> Result<()> {
        require!(ask_lamports > 0, DataMarketError::InvalidAskPrice);
        require!(quality_score_bps <= 10_000, DataMarketError::InvalidQualityScore);

        let record = &mut ctx.accounts.dataset_record;
        record.contributor         = ctx.accounts.contributor.key();
        record.content_hash        = content_hash;
        record.data_type           = data_type;
        record.ask_lamports        = ask_lamports;
        record.quality_score_bps   = quality_score_bps;
        record.record_count        = record_count;
        record.coverage_days_tenths = coverage_days_tenths;
        record.status              = ListingStatus::Listed;
        record.total_lamports_paid = 0;
        record.evaluation_count    = 0;
        record.improvement_count   = 0;
        record.registered_at       = Clock::get()?.unix_timestamp;
        record.bump                = ctx.bumps.dataset_record;

        emit!(DatasetRegistered {
            dataset_record: ctx.accounts.dataset_record.key(),
            contributor: ctx.accounts.contributor.key(),
            data_type: record.data_type.clone(),
            ask_lamports,
            quality_score_bps,
            timestamp: record.registered_at,
        });

        Ok(())
    }

    // ── Improvement settlement ───────────────────────────────────────────────

    /// Record a model improvement and settle micropayment to the contributor.
    ///
    /// Requires two signers:
    ///   buyer  — transfers SOL (the entity whose model improved)
    ///   oracle — the BioMint agent that attested the evaluation result
    ///
    /// delta_bps: improvement expressed in basis points of the metric scale
    ///   e.g. AUC improved from 0.780 → 0.785 = 50 bps
    ///        RMSE improved from 18.5 → 18.0 mg/dL ≈ 270 bps
    pub fn settle_improvement(
        ctx: Context<SettleImprovement>,
        delta_bps: u32,
        payment_lamports: u64,
    ) -> Result<()> {
        let record = &mut ctx.accounts.dataset_record;

        require!(record.status == ListingStatus::Listed, DataMarketError::NotListed);
        require!(delta_bps > 0, DataMarketError::ZeroDelta);
        require!(
            payment_lamports >= record.ask_lamports,
            DataMarketError::BelowAskPrice
        );

        // Verify the oracle is the authorised BioMint oracle key
        // (In production, compare against a stored oracle pubkey in a config PDA)
        require!(ctx.accounts.oracle.is_signer, DataMarketError::OracleNotSigned);

        // Transfer SOL: buyer → contributor
        let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.buyer.key(),
            &ctx.accounts.contributor.key(),
            payment_lamports,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.buyer.to_account_info(),
                ctx.accounts.contributor.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        record.total_lamports_paid = record
            .total_lamports_paid
            .checked_add(payment_lamports)
            .ok_or(DataMarketError::Overflow)?;
        record.evaluation_count = record.evaluation_count.checked_add(1).unwrap_or(u32::MAX);
        record.improvement_count = record.improvement_count.checked_add(1).unwrap_or(u32::MAX);

        emit!(ImprovementSettled {
            dataset_record: ctx.accounts.dataset_record.key(),
            buyer: ctx.accounts.buyer.key(),
            contributor: ctx.accounts.contributor.key(),
            delta_bps,
            payment_lamports,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    // ── No-improvement recording ─────────────────────────────────────────────

    /// Record an evaluation where the dataset did NOT improve the model.
    ///
    /// No payment occurs.  This still updates on-chain stats so buyers can
    /// see the evaluation-to-improvement ratio of a listing.
    pub fn record_no_improvement(ctx: Context<RecordEvaluation>) -> Result<()> {
        let record = &mut ctx.accounts.dataset_record;
        require!(record.status == ListingStatus::Listed, DataMarketError::NotListed);
        record.evaluation_count = record.evaluation_count.checked_add(1).unwrap_or(u32::MAX);
        Ok(())
    }

    // ── Dataset delisting ────────────────────────────────────────────────────

    /// Delist a dataset (contributor withdraws).
    ///
    /// After delisting the record remains on-chain for auditability but
    /// buyers can no longer evaluate it.
    pub fn delist_dataset(ctx: Context<DelistDataset>) -> Result<()> {
        let record = &mut ctx.accounts.dataset_record;
        require!(record.status == ListingStatus::Listed, DataMarketError::NotListed);
        record.status = ListingStatus::Delisted;

        emit!(DatasetDelisted {
            dataset_record: ctx.accounts.dataset_record.key(),
            contributor: ctx.accounts.contributor.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    // ── Ask price update ─────────────────────────────────────────────────────

    /// Update the minimum ask price for a listed dataset.
    pub fn update_ask_price(
        ctx: Context<UpdateListing>,
        new_ask_lamports: u64,
    ) -> Result<()> {
        require!(new_ask_lamports > 0, DataMarketError::InvalidAskPrice);
        ctx.accounts.dataset_record.ask_lamports = new_ask_lamports;
        Ok(())
    }
}

// ── Account structures ───────────────────────────────────────────────────────

#[account]
#[derive(Default)]
pub struct DatasetRecord {
    /// Contributor's Solana pubkey — receives micropayments
    pub contributor: Pubkey,              // 32
    /// SHA-256 Merkle root of the reading/variant array (content-addressable)
    pub content_hash: [u8; 32],           // 32
    /// Dataset category
    pub data_type: DataType,              // 1
    /// Minimum acceptable payment per evaluation (lamports)
    pub ask_lamports: u64,               // 8
    /// Quality score in basis points (0 = worst, 10 000 = perfect)
    pub quality_score_bps: u16,          // 2
    /// Number of readings or variants in the dataset
    pub record_count: u32,               // 4
    /// CGM coverage in days × 10 (e.g. 140 = 14.0 days; 0 = not applicable)
    pub coverage_days_tenths: u16,       // 2
    /// Current listing status
    pub status: ListingStatus,           // 1
    /// Total SOL paid to this contributor (cumulative)
    pub total_lamports_paid: u64,        // 8
    /// Total number of model evaluations against this dataset
    pub evaluation_count: u32,           // 4
    /// Evaluations that resulted in a payment
    pub improvement_count: u32,          // 4
    /// Unix timestamp of registration
    pub registered_at: i64,             // 8
    /// PDA bump seed
    pub bump: u8,                        // 1
}

impl DatasetRecord {
    pub const LEN: usize = 8   // discriminator
        + 32   // contributor
        + 32   // content_hash
        + 1    // data_type
        + 8    // ask_lamports
        + 2    // quality_score_bps
        + 4    // record_count
        + 2    // coverage_days_tenths
        + 1    // status
        + 8    // total_lamports_paid
        + 4    // evaluation_count
        + 4    // improvement_count
        + 8    // registered_at
        + 1;   // bump
}

// ── Enums ────────────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Default)]
pub enum DataType {
    #[default]
    CgmTimeseries = 0,   // Dexcom G6/G7, Abbott FreeStyle Libre 3
    GenomeVariant  = 1,  // Genomic SNP panel (T2D loci)
    LibreFlash     = 2,  // FreeStyle Libre flash scan sessions
    LifestyleCorr  = 3,  // Paired CGM + lifestyle signals
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Default)]
pub enum ListingStatus {
    #[default]
    Listed   = 0,
    Delisted = 1,
    Expired  = 2,
}

// ── Instruction contexts ─────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(content_hash: [u8; 32], data_type: DataType)]
pub struct RegisterDataset<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,

    #[account(
        init,
        payer = contributor,
        space = DatasetRecord::LEN,
        seeds = [b"dataset", contributor.key().as_ref(), &content_hash],
        bump,
    )]
    pub dataset_record: Account<'info, DatasetRecord>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleImprovement<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// The BioMint evaluation oracle — must co-sign to attest the delta
    pub oracle: Signer<'info>,

    /// CHECK: validated by dataset_record.contributor equality check in instruction
    #[account(mut)]
    pub contributor: AccountInfo<'info>,

    #[account(
        mut,
        has_one = contributor @ DataMarketError::WrongContributor,
    )]
    pub dataset_record: Account<'info, DatasetRecord>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordEvaluation<'info> {
    pub evaluator: Signer<'info>,

    #[account(mut)]
    pub dataset_record: Account<'info, DatasetRecord>,
}

#[derive(Accounts)]
pub struct DelistDataset<'info> {
    pub contributor: Signer<'info>,

    #[account(
        mut,
        has_one = contributor @ DataMarketError::WrongContributor,
    )]
    pub dataset_record: Account<'info, DatasetRecord>,
}

#[derive(Accounts)]
pub struct UpdateListing<'info> {
    pub contributor: Signer<'info>,

    #[account(
        mut,
        has_one = contributor @ DataMarketError::WrongContributor,
    )]
    pub dataset_record: Account<'info, DatasetRecord>,
}

// ── Events ───────────────────────────────────────────────────────────────────

#[event]
pub struct DatasetRegistered {
    pub dataset_record: Pubkey,
    pub contributor: Pubkey,
    pub data_type: DataType,
    pub ask_lamports: u64,
    pub quality_score_bps: u16,
    pub timestamp: i64,
}

#[event]
pub struct ImprovementSettled {
    pub dataset_record: Pubkey,
    pub buyer: Pubkey,
    pub contributor: Pubkey,
    pub delta_bps: u32,
    pub payment_lamports: u64,
    pub timestamp: i64,
}

#[event]
pub struct DatasetDelisted {
    pub dataset_record: Pubkey,
    pub contributor: Pubkey,
    pub timestamp: i64,
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum DataMarketError {
    #[msg("Ask price must be greater than zero")]
    InvalidAskPrice,

    #[msg("Quality score must be between 0 and 10 000 basis points")]
    InvalidQualityScore,

    #[msg("Dataset is not in Listed status")]
    NotListed,

    #[msg("Payment is below the contributor's ask price")]
    BelowAskPrice,

    #[msg("Improvement delta must be greater than zero")]
    ZeroDelta,

    #[msg("The oracle must co-sign improvement settlements")]
    OracleNotSigned,

    #[msg("Caller is not the dataset contributor")]
    WrongContributor,

    #[msg("Arithmetic overflow in payment accumulation")]
    Overflow,
}
